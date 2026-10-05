import Foundation
import Observation

/// A file to show: in Quick Look (a safe type) or handed to other apps (the share sheet).
struct OpenableFile: Identifiable, Equatable {
    var id: URL { url }
    let url: URL
}

/// A tap on an attachment. An image opens in the in-app viewer (the thumbnail first, the full
/// picture downloads under it); any other file downloads into the app's cache — its progress and
/// failure on the tile — and then opens in Quick Look when the type of its extension is one the
/// server itself serves as safe, otherwise it is offered to other apps («Открыть в…»). The sender's
/// `mimeType` never decides. A second tap while it downloads does nothing; after a failure it tries
/// again (and resumes).
@MainActor
@Observable
final class AttachmentOpener {
    enum Transfer: Equatable {
        /// 0…1, nil while the size is unknown.
        case running(Double?)
        case failed(String)
        case ready(URL)
    }

    private(set) var transfers: [Int64: Transfer] = [:]
    /// The image shown full screen; nil — closed.
    var viewer: MessageAttachment?
    /// A downloaded file shown in Quick Look.
    var preview: OpenableFile?
    /// A downloaded file whose type is not shown inside the app: offered to other apps.
    var shareable: OpenableFile?
    /// Why the last download failed (for the chat's notice).
    var notice: String?

    @ObservationIgnored private let downloader: AttachmentDownloader
    @ObservationIgnored private let typeForExtension: (String) -> String?

    init(downloader: AttachmentDownloader, typeForExtension: @escaping (String) -> String?) {
        self.downloader = downloader
        self.typeForExtension = typeForExtension
    }

    func open(_ attachment: MessageAttachment) {
        if attachment.isImage {
            viewer = attachment
            if let id = attachment.fileId, attachment.localFile == nil, !isReady(id) { fetch(attachment, show: false) }
            return
        }
        if let local = attachment.localFile {
            show(local, name: attachment.name)
            return
        }
        fetch(attachment, show: true)
    }

    /// «Повторить» in the viewer.
    func retry(_ attachment: MessageAttachment) {
        fetch(attachment, show: !attachment.isImage)
    }

    func closeViewer() {
        viewer = nil
    }

    private func isReady(_ id: Int64) -> Bool {
        if case .ready? = transfers[id] { return true }
        return false
    }

    private func show(_ file: URL, name: String) {
        if AttachmentRules.openType(forName: name, typeForExtension: typeForExtension) != nil {
            preview = OpenableFile(url: file)
        } else {
            shareable = OpenableFile(url: file)
        }
    }

    private func fetch(_ attachment: MessageAttachment, show: Bool) {
        guard let id = attachment.fileId else { return }
        if case .running? = transfers[id] { return }
        transfers[id] = .running(nil)
        let downloader = self.downloader
        // The opener lives as long as the chat screen; a download in flight keeps it a little longer.
        Task {
            do {
                let file = try await downloader.fetch(fileId: id, name: attachment.name) { progress in
                    Task { @MainActor in self.progress(id, progress) }
                }
                self.transfers[id] = .ready(file)
                if show { self.show(file, name: attachment.name) }
            } catch {
                if error is CancellationError {
                    self.transfers[id] = nil
                    return
                }
                let reason = (error as? AttachmentError)?.message ?? String(localized: "Не удалось скачать файл")
                self.transfers[id] = .failed(reason)
                if !attachment.isImage { self.notice = reason }
            }
        }
    }

    private func progress(_ id: Int64, _ value: Double?) {
        guard case .running = transfers[id] else { return }
        transfers[id] = .running(value)
    }
}
