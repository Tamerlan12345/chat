import Foundation
import Observation

/// A file the user picked: where its bytes are, its name and type.
struct PickedAttachment: Sendable {
    enum Source: Sendable {
        /// A file the app may read now (the document picker's copy, a temporary file).
        case file(URL)
        /// Bytes already in memory (a photo).
        case data(Data)
    }

    let source: Source
    let name: String
    let mimeType: String
    var width: Int?
    var height: Int?
}

/// The app's private copies of files waiting to go up: `Application Support/Outbox/<key>/<name>`,
/// excluded from backup, deleted once the message is confirmed, cancelled or the account's data is
/// wiped.
struct AttachmentFiles: Sendable {
    let root: URL

    static func defaultRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("Outbox", isDirectory: true)
    }

    /// Copies the picked bytes; returns the copy's path (relative to `root`) and size.
    func keep(_ picked: PickedAttachment, key: String) throws -> (path: String, size: Int64) {
        let files = FileManager.default
        let folder = root.appendingPathComponent(key, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        let name = AttachmentRules.safeFileName(picked.name)
        let target = folder.appendingPathComponent(name)
        switch picked.source {
        case .data(let data):
            try data.write(to: target, options: .atomic)
        case .file(let url):
            if files.fileExists(atPath: target.path) { try files.removeItem(at: target) }
            try files.copyItem(at: url, to: target)
        }
        let size = (try files.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
        return ("\(key)/\(name)", size)
    }

    func url(_ path: String) -> URL {
        root.appendingPathComponent(path)
    }

    /// Deletes the copy of one file (its whole folder).
    func discard(_ path: String) {
        guard let key = path.split(separator: "/").first else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(String(key), isDirectory: true))
    }

    /// Deletes every copy whose key is not in `keys` (left from an earlier process).
    func prune(keeping keys: Set<String>) {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for folder in folders where !keys.contains(folder.lastPathComponent) {
            try? FileManager.default.removeItem(at: folder)
        }
    }

    func removeAll() throws {
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
    }
}

/// The multipart body of an upload as a file, so it streams from disk (`URLSession.upload(fromFile:)`):
/// memory stays flat and the progress is real.
enum MultipartFile {
    static func write(file: URL, fieldName: String, fileName: String, mimeType: String, boundary: String, in folder: URL) throws -> URL {
        let target = folder.appendingPathComponent("upload-\(UUID().uuidString).multipart")
        // A quote or a line break would end the header field early.
        let name = fileName.filter { $0 != "\"" && $0 != "\r" && $0 != "\n" }
        let head = "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(name)\"\r\nContent-Type: \(mimeType)\r\n\r\n"
        guard FileManager.default.createFile(atPath: target.path, contents: Data(head.utf8)) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let output = try FileHandle(forWritingTo: target)
            defer { try? output.close() }
            try output.seekToEnd()
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
                try output.write(contentsOf: chunk)
            }
            try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        return target
    }
}

/// `POST /api/files/upload` (multipart, field `file`).
protocol AttachmentUploader: Sendable {
    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse
}

/// Files on their way into the outbox. A picked file is kept as the app's private copy and recorded
/// before anything else happens (so it survives termination), goes up when there is a connection,
/// and only then enters the delivery outbox as a `file`/`image` message with the same
/// `client_msg_id` (`delivery-state.md` §3.1). A network failure leaves it queued (it goes again by
/// itself); the server's refusal fails it with the server's reason («Повторить» / «Удалить»).
@MainActor
@Observable
final class AttachmentUploads {
    struct Item: Identifiable, Equatable {
        var id: String { pending.clientMsgId }
        var pending: PendingUpload
        /// 0…1 while it is going up.
        var progress: Double?
    }

    struct Notice: Equatable {
        let conversation: String
        let text: String
        let serial: Int
    }

    /// Uploads at once: the server takes two per person (`MAX_PARALLEL_UPLOADS`) and answers 429
    /// «Дождитесь окончания текущих загрузок» beyond.
    nonisolated static let maxConcurrent = 2

    /// Pause before a queued file goes again while the connection stays up.
    nonisolated static let retryDelayMs: Int64 = 15_000

    private(set) var items: [Item] = [] {
        didSet { onChange?() }
    }
    /// Files already in the outbox (uploaded), until the server confirms them: the bubble keeps
    /// drawing the local copy instead of flashing to the server's thumbnail.
    private(set) var handedOver: [String: PendingUpload] = [:] {
        didSet { onChange?() }
    }
    /// The server refused a file (its reason, for the open chat).
    private(set) var lastNotice: Notice? {
        didSet { if let lastNotice { onNotice?(lastNotice) } }
    }

    /// Called after `items` or `handedOver` changed.
    @ObservationIgnored var onChange: (@MainActor () -> Void)?
    /// Called with every refused file.
    @ObservationIgnored var onNotice: (@MainActor (Notice) -> Void)?

    @ObservationIgnored private let store: any PendingUploadStore
    @ObservationIgnored let files: AttachmentFiles
    @ObservationIgnored private let uploader: any AttachmentUploader
    @ObservationIgnored private let engine: DeliveryEngine
    @ObservationIgnored private let clock: any DeliveryClock
    @ObservationIgnored private let owner: @MainActor () -> Int64?
    @ObservationIgnored private let log: @Sendable (String) -> Void
    @ObservationIgnored private var online = false
    @ObservationIgnored private var flushing = false
    /// Files the user asked to retry: they go whatever the connection, as soon as a slot is free.
    @ObservationIgnored private var forced = Set<String>()
    /// The attempt under way per file: progress reports of an ended attempt are dropped.
    @ObservationIgnored private var attempts: [String: UUID] = [:]
    /// Uploaded, waiting to enter the outbox after the files picked before them.
    @ObservationIgnored private var uploaded: [String: FileUploadResponse] = [:]
    @ObservationIgnored private var enqueuing = false
    @ObservationIgnored private var started = false
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    @ObservationIgnored private var running: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var retries: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var noticeSerial = 0
    /// Bumped by a wipe: an upload of the old account that answers later is dropped.
    @ObservationIgnored private var epoch = 0

    init(
        store: any PendingUploadStore,
        files: AttachmentFiles,
        uploader: any AttachmentUploader,
        engine: DeliveryEngine,
        clock: any DeliveryClock = SystemDeliveryClock(),
        owner: @escaping @MainActor () -> Int64?,
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.store = store
        self.files = files
        self.uploader = uploader
        self.engine = engine
        self.clock = clock
        self.owner = owner
        self.log = log
    }

    /// Loads the files that waited across a restart; forgets them when the queue is wiped.
    func start() {
        guard !started else { return }
        started = true
        engine.onWipe.append { [weak self] in self?.forget() }
        engine.onStateChange.append { [weak self] state in self?.dropConfirmed(state) }
        restoreTask = Task { [weak self] in await self?.restore() }
    }

    /// Returns once the stored files are loaded.
    func restored() async {
        await restoreTask?.value
    }

    private func restore() async {
        // Whose queue it is is known only once the engine has read, owner-checked and claimed its
        // model for an account: rows are never loaded under a model that names nobody.
        await engine.waitUntilOwned()
        let stored: [PendingUpload]
        do {
            stored = try await store.uploads()
        } catch {
            log("waiting files could not be read: \(error)")
            return
        }
        // Another account's waiting files are never loaded: deleted with their copies.
        let owner = engine.state.me
        let foreign = stored.filter { $0.owner != owner }
        for upload in foreign {
            try? await store.removeUpload(upload.clientMsgId)
            files.discard(upload.localPath)
        }
        let known = Set(items.map(\.id))
        items += stored.filter { !known.contains($0.clientMsgId) && $0.owner == owner }.map { Item(pending: $0) }
        // A copy is needed only while its file waits; the rest are left from an earlier process.
        files.prune(keeping: Set(items.map(\.id)).union(engine.state.outbox.map(\.clientMsgId)))
        pump()
    }

    /// The socket is up (or not): waiting files go when it is.
    func setOnline(_ value: Bool) {
        online = value
        if value { pump() }
    }

    /// Keeps `picked` for `conversation` (a private copy and a stored row) and starts it when online.
    /// False when the file could not be kept: nothing was queued.
    func add(conversation: String, picked: PickedAttachment, replyToId: Int64?, owner: Int64) async -> Bool {
        // A restore under way prunes copies it does not know: let it finish first. (Before the queue
        // has an owner nothing is restored yet; it keeps whatever is in `items` when it runs.)
        if engine.ready && engine.state.me != nil { await restored() }
        let key = DeliveryEngine.newClientMsgId()
        let files = self.files
        let kept: (path: String, size: Int64)
        do {
            kept = try await Task.detached { try files.keep(picked, key: key) }.value
        } catch {
            log("a picked file could not be kept: \(error)")
            return false
        }
        let pending = PendingUpload(
            clientMsgId: key,
            conversation: conversation,
            owner: owner,
            createdAt: clock.now(),
            name: picked.name,
            size: kept.size,
            mimeType: picked.mimeType,
            width: picked.width,
            height: picked.height,
            localPath: kept.path,
            replyToId: replyToId
        )
        do {
            try await store.putUpload(pending)
        } catch {
            log("a picked file could not be recorded: \(error)")
            files.discard(kept.path)
            return false
        }
        items.append(Item(pending: pending))
        pump()
        return true
    }

    /// «Повторить» on a refused file: it goes up again.
    func retry(_ clientMsgId: String) {
        guard let index = items.firstIndex(where: { $0.id == clientMsgId }), items[index].pending.failed else { return }
        items[index].pending.failed = false
        items[index].pending.error = nil
        let again = items[index].pending
        let store = self.store
        Task { try? await store.putUpload(again) }
        // «Повторить» sends this file, network or not, and keeps that right until a slot is free;
        // the other waiting files still wait for the network.
        forced.insert(clientMsgId)
        pump()
    }

    /// «Отменить» / «Удалить»: the upload stops and the file is forgotten.
    func cancel(_ clientMsgId: String) async {
        guard let item = items.first(where: { $0.id == clientMsgId }) else { return }
        running.removeValue(forKey: clientMsgId)?.cancel()
        retries.removeValue(forKey: clientMsgId)?.cancel()
        items.removeAll { $0.id == clientMsgId }
        uploaded[clientMsgId] = nil
        forced.remove(clientMsgId)
        attempts[clientMsgId] = nil
        do {
            try await store.removeUpload(clientMsgId)
        } catch {
            log("a cancelled file's row could not be deleted: \(error)")
        }
        files.discard(item.pending.localPath)
        // A later file that waited for this one goes now.
        await enqueueUploaded()
    }

    /// Every waiting file goes now, whatever the socket; returns when they settled (the flush
    /// without a socket), two at a time.
    func flush() async {
        // A queue that names no account has nothing to send yet.
        guard engine.state.me != nil else { return }
        await restored()
        flushing = true
        defer { flushing = false }
        repeat {
            pump(ignoringConnection: true)
            for task in Array(running.values) { await task.value }
        } while !running.isEmpty || pendingKeys().contains { canLaunch($0) }
    }

    /// Waiting (not refused) files of `owner`.
    func waitingCount(of owner: Int64?) -> Int {
        items.filter { $0.pending.owner == owner }.count
    }

    /// Explicit sign-out, step one: the rows go first; if they cannot be deleted nothing is (the
    /// files in memory and their copies stay). The memory is emptied by the queue's wipe that follows.
    func clearStoredRows() async throws {
        try await store.clearUploads()
    }

    /// The sign-out did not go through after the rows were deleted: they are written back.
    func restoreStoredRows() async {
        for item in items {
            do {
                try await store.putUpload(item.pending)
            } catch {
                log("a waiting file's row could not be written back: \(error)")
            }
        }
    }

    /// The queue was wiped (sign-out, another account): stop and forget the files.
    private func forget() {
        epoch += 1
        running.values.forEach { $0.cancel() }
        running.removeAll()
        retries.values.forEach { $0.cancel() }
        retries.removeAll()
        items.removeAll()
        handedOver.removeAll()
        uploaded.removeAll()
        forced.removeAll()
        attempts.removeAll()
        let store = self.store
        let files = self.files
        let log = self.log
        Task {
            do {
                try await store.clearUploads()
            } catch {
                log("waiting files could not be deleted: \(error)")
            }
            files.prune(keeping: [])
        }
    }

    /// Once the outbox no longer holds a handed-over file (confirmed or dropped), its copy goes.
    private func dropConfirmed(_ state: DeliveryState) {
        guard !handedOver.isEmpty else { return }
        let inOutbox = Set(state.outbox.map(\.clientMsgId))
        for (key, pending) in handedOver where !inOutbox.contains(key) {
            handedOver[key] = nil
            files.discard(pending.localPath)
        }
    }

    private func pendingKeys() -> [String] {
        items.filter { !$0.pending.failed && $0.progress == nil }.map(\.id)
    }

    /// Files go up only for the account that picked them, never under another account's token.
    private func mayUpload(_ pending: PendingUpload) -> Bool {
        guard engine.ready, let user = owner(), user == pending.owner else { return false }
        return engine.state.me == nil || engine.state.me == user
    }

    private func canLaunch(_ key: String) -> Bool {
        guard running[key] == nil, retries[key] == nil, uploaded[key] == nil,
              let item = items.first(where: { $0.id == key }), item.progress == nil else { return false }
        return !item.pending.failed && mayUpload(item.pending)
    }

    /// Starts waiting files while a slot is free, first picked first up: with a connection (or in a
    /// flush) any of them, otherwise only those the user asked to retry.
    private func pump(ignoringConnection: Bool = false) {
        let any = ignoringConnection || online || flushing
        for item in items where running.count < Self.maxConcurrent && canLaunch(item.id) {
            guard any || forced.contains(item.id) else { continue }
            forced.remove(item.id)
            start(item.id)
        }
    }

    private func start(_ key: String) {
        guard let item = items.first(where: { $0.id == key }) else { return }
        let session = epoch
        let attempt = UUID()
        attempts[key] = attempt
        running[key] = Task { [weak self] in
            await self?.upload(item.pending, session: session, attempt: attempt)
            guard let self, self.epoch == session else { return }
            self.running[key] = nil
            // A slot freed: the next waiting file goes.
            self.pump()
        }
    }

    private func setProgress(_ key: String, _ progress: Double?) {
        guard let index = items.firstIndex(where: { $0.id == key }) else { return }
        items[index].progress = progress
    }

    private func upload(_ pending: PendingUpload, session: Int, attempt: UUID) async {
        let key = pending.clientMsgId
        setProgress(key, 0)
        let uploader = self.uploader
        let file = files.url(pending.localPath)
        let mimeType = pending.mimeType ?? "application/octet-stream"
        do {
            let done = try await uploader.upload(file: file, name: pending.name, mimeType: mimeType) { [weak self] value in
                Task { @MainActor in
                    // Only the attempt still under way reports progress: a late report must not
                    // mark a file as going up after its attempt ended (it would never go again).
                    guard let self, self.epoch == session, self.attempts[key] == attempt else { return }
                    if let current = self.items.first(where: { $0.id == key })?.progress, Int(current * 100) == Int(value * 100) { return }
                    self.setProgress(key, value)
                }
            }
            if attempts[key] == attempt { attempts[key] = nil }
            guard epoch == session, items.contains(where: { $0.id == key }) else { return }
            setProgress(key, 1)
            uploaded[key] = done
            await enqueueUploaded()
        } catch {
            if attempts[key] == attempt { attempts[key] = nil }
            guard epoch == session, items.contains(where: { $0.id == key }) else { return }
            if error is CancellationError { return }
            if let wait = AttachmentRules.retryDelayMs(error) {
                // No answer, or the server asks to wait: not refused, it goes again later.
                setProgress(key, nil)
                scheduleRetry(key, after: wait)
                return
            }
            let reason = AttachmentRules.failureText(error)
            guard let index = items.firstIndex(where: { $0.id == key }) else { return }
            items[index].progress = nil
            items[index].pending.failed = true
            items[index].pending.error = reason
            let failed = items[index].pending
            do {
                try await store.putUpload(failed)
            } catch {
                log("a refused file could not be recorded: \(error)")
            }
            noticeSerial += 1
            lastNotice = Notice(conversation: pending.conversation, text: reason, serial: noticeSerial)
            // A refused file does not hold up the ones picked after it.
            await enqueueUploaded()
        }
    }

    /// Uploaded files enter the outbox in the order they were picked (per conversation): a later file
    /// that finished first waits for the earlier ones that are still going up; a refused one does not
    /// hold the queue.
    private func enqueueUploaded() async {
        guard !enqueuing else { return }
        enqueuing = true
        defer { enqueuing = false }
        var progressed = true
        while progressed {
            progressed = false
            var waitingFor = Set<String>()
            for item in items where !item.pending.failed {
                let conversation = item.pending.conversation
                guard let done = uploaded[item.id] else {
                    waitingFor.insert(conversation)
                    continue
                }
                guard !waitingFor.contains(conversation) else { continue }
                await handOver(item.pending, done)
                progressed = true
                break
            }
        }
    }

    private func handOver(_ pending: PendingUpload, _ done: FileUploadResponse) async {
        let key = pending.clientMsgId
        let session = epoch
        uploaded[key] = nil
        do {
            let metadata = AttachmentRules.metadata(fileId: done.id, size: done.fileSize, mimeType: done.mimeType, width: pending.width ?? done.width, height: pending.height ?? done.height)
            let outcome = await engine.enqueue(
                conversation: pending.conversation,
                text: pending.name,
                msgType: AttachmentRules.isImage(name: pending.name, mimeType: pending.mimeType) ? "image" : "file",
                replyToId: pending.replyToId,
                metadata: metadata,
                clientMsgId: key,
                owner: pending.owner
            )
            guard epoch == session else { return }
            if !outcome.persisted {
                // The outbox could not be written: the file waits and goes again.
                setProgress(key, nil)
                scheduleRetry(key)
                return
            }
            if engine.state.outbox.contains(where: { $0.clientMsgId == key }) {
                handedOver[key] = pending
            } else {
                files.discard(pending.localPath)
            }
            items.removeAll { $0.id == key }
            do {
                try await store.removeUpload(key)
            } catch {
                log("an uploaded file's row could not be deleted: \(error)")
            }
        }
    }

    private func scheduleRetry(_ key: String, after wait: Int64 = AttachmentUploads.retryDelayMs) {
        retries.removeValue(forKey: key)?.cancel()
        let clock = self.clock
        retries[key] = Task { [weak self] in
            try? await clock.sleep(milliseconds: wait)
            guard !Task.isCancelled, let self else { return }
            self.retries[key] = nil
            self.pump()
        }
    }
}
