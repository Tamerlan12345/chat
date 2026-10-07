package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.RequestOwner
import com.openmychat.mobile.core.network.RetryAfter
import com.openmychat.mobile.data.model.FileUploadResponse
import com.openmychat.mobile.data.delivery.DeliveryEngine
import com.openmychat.mobile.data.delivery.PendingUpload
import com.openmychat.mobile.data.delivery.UploadStore
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.repository.AttachmentRepository
import com.openmychat.mobile.data.repository.PickedFile
import com.openmychat.mobile.features.attachments.Attachments
import com.openmychat.mobile.features.attachments.UploadRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Files on their way into the outbox. A picked file is kept as the app's private copy and recorded
 * in [UploadStore] before anything else happens (so it survives process death), goes up over HTTP
 * when there is a connection (the foreground socket, or a background flush), and only then enters the
 * delivery outbox as a `file`/`image` message with the same `client_msg_id` (delivery-state.md §3.1).
 *
 * At most [MAX_PARALLEL] files go up at once (the server's limit per person), in the order they were
 * picked, and they enter the outbox in that order per conversation: a later file that finished first
 * waits for the earlier ones still going up; a refused one does not hold the rest (final review I2,
 * parity P1/P3).
 *
 * A network failure, an expired session, and the server's temporary refusals (408, 429, 5xx, 507)
 * leave the file queued — it goes again by itself, after the server's `Retry-After` (at most 30 s)
 * or [retryDelayMs]; after [MAX_ATTEMPTS] temporary refusals in a row it is failed. The server's
 * refusal of the file itself fails it with the server's reason («Повторить» / «Удалить»). Cancelling
 * stops the upload and forgets the file; a file cancelled once it is up is never sent (M1).
 */
class AttachmentSends(
    private val scope: CoroutineScope,
    private val store: UploadStore,
    private val files: AttachmentRepository,
    private val engine: DeliveryEngine,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Pause before a queued file goes again while the connection stays up. */
    private val retryDelayMs: Long = 15_000L,
    /** The signed-in account: files go up only for the account that owns the queue. */
    private val owner: () -> Long? = { null }
) {
    /** One file on screen: [progress] is set while it is going up. */
    data class Upload(val pending: PendingUpload, val progress: Float? = null)

    private val _uploads = MutableStateFlow<List<Upload>>(emptyList())
    val uploads: StateFlow<List<Upload>> = _uploads.asStateFlow()

    private val _notices = MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 8)

    /** (conversation, the server's reason) when a file is refused. */
    val notices: SharedFlow<Pair<String, String>> = _notices.asSharedFlow()

    private val _handedOver = MutableStateFlow<Map<String, LocalUpload>>(emptyMap())

    /**
     * Files already in the outbox (uploaded, `file_id` known), until the server confirms them: the
     * bubble keeps drawing the local copy instead of flashing to the server's thumbnail.
     */
    val handedOver: StateFlow<Map<String, LocalUpload>> = _handedOver.asStateFlow()

    private val jobs = HashMap<String, Job>()
    private val retries = HashMap<String, Job>()

    /** Upload slots: the server takes two uploads per person at a time. Fair (FIFO). */
    private val slots = Semaphore(MAX_PARALLEL)

    /** Files that are up (the server has them) and wait for their turn into the outbox. */
    private class Uploaded(val response: FileUploadResponse, val account: Long)
    private val uploaded = java.util.concurrent.ConcurrentHashMap<String, Uploaded>()

    /** Files cancelled by the person: never handed to the outbox, whatever is in flight. */
    private val cancelled: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /** Temporary refusals in a row per file. */
    private val temporaryFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()

    /** One hand-over pass at a time, so the outbox gets the files in order. */
    private val handingOver = Mutex()
    private val loaded = Mutex()
    @Volatile private var restored = false
    @Volatile private var online = false
    private var started = false

    /**
     * The account each listed file belongs to: the queue's owner on disk when its row was read, or the
     * account that added it. A file goes up, and enters the outbox, only as that account.
     */
    private val owners = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** Loads the files that waited across a restart and sends them whenever [connected] is true. */
    @Synchronized
    fun start(connected: Flow<Boolean>) {
        if (started) return
        started = true
        scope.launch {
            // The queue was wiped (sign-out, another account): its files go too.
            engine.wiped.collect { forget() }
        }
        scope.launch {
            // An account took the queue after a wipe (signed in, or a sign-out called off whose delete
            // failed): the files stored for it are listed again.
            engine.state.collect { state ->
                if (state.me != null && !restored) {
                    restore()
                    if (online) pendingKeys().forEach(::launchUpload)
                }
            }
        }
        scope.launch {
            // Once the outbox no longer holds a handed-over file (confirmed or dropped), its copy goes.
            engine.state.collect { state ->
                val gone = _handedOver.value.filterKeys { key -> state.outbox.none { it.clientMsgId == key } }
                if (gone.isEmpty()) return@collect
                _handedOver.update { it - gone.keys }
                gone.values.forEach { upload -> runCatching { files.discard(upload.toPicked()) } }
            }
        }
        scope.launch {
            restore()
            connected.collect { up ->
                online = up
                if (up) pendingKeys().forEach(::launchUpload)
            }
        }
    }

    private suspend fun restore() = loaded.withLock {
        if (restored) return@withLock
        // Only after the engine checked the store's owner (another account's rows are wiped by then).
        engine.awaitReady()
        restored = true
        // In the order they were picked: that is the order they go up and enter the outbox.
        val stored = runCatching { store.all() }.getOrDefault(emptyList()).sortedBy { it.createdAt }
        // Rows are read once the engine checked the owner: they belong to the owner on disk (rows
        // of no named account are never sent; the next claim wipes them).
        owners.clear()
        engine.ownerOnDisk?.let { account -> stored.forEach { owners[it.clientMsgId] = account } }
        _uploads.value = stored.map { Upload(it) }
        // A copy is needed only while its file waits to go up; the rest are left from a past process.
        runCatching { files.pruneKept(stored.mapTo(HashSet()) { it.clientMsgId }) }
    }

    /**
     * Keeps [picked] for [conversation] (a private copy and a stored row) and starts it when online.
     * [screenAccount] — the account of the screen the file was picked on: refused when another one is
     * signed in by now (final review M4). False when the file could not be kept: nothing was queued.
     */
    suspend fun add(conversation: String, picked: PickedFile, replyToId: Long?, screenAccount: Long? = null): Boolean {
        // A row is written only under its account's name on disk.
        val account = owner() ?: return false
        if (screenAccount != null && screenAccount != account) return false
        if (!engine.ready.value || engine.ownerOnDisk != account) return false
        restore()
        val key = DeliveryEngine.newClientMsgId()
        // The copy and its row are written under the same lock as a prune of copies against rows,
        // so a prune that read the rows before this one never deletes this copy.
        val pending = loaded.withLock { keep(conversation, picked, replyToId, key, account) } ?: return false
        _uploads.update { it + Upload(pending) }
        if (online) launchUpload(key)
        return true
    }

    private suspend fun keep(conversation: String, picked: PickedFile, replyToId: Long?, key: String, account: Long): PendingUpload? {
        val kept = runCatching { files.keep(picked, key) }.getOrNull() ?: return null
        val pending = PendingUpload(
            clientMsgId = key,
            conversation = conversation,
            createdAt = clock(),
            name = picked.name,
            size = kept.size ?: picked.size,
            mimeType = picked.mimeType,
            width = picked.width,
            height = picked.height,
            uri = kept.uri,
            replyToId = replyToId
        )
        try {
            store.put(pending)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            files.discard(kept)
            return null
        }
        owners[key] = account
        return pending
    }

    /** «Повторить» on a refused file: it goes up again (the server's reason is cleared). */
    fun retry(clientMsgId: String) {
        val upload = find(clientMsgId) ?: return
        if (!upload.pending.failed) return
        temporaryFailures.remove(clientMsgId)
        val again = upload.pending.copy(failed = false, error = null)
        replace(again)
        scope.launch { runCatching { store.put(again) } }
        launchUpload(clientMsgId, ignoreConnection = true)
    }

    /** «Отменить» / «Удалить»: the upload stops and the file is forgotten. */
    fun cancel(clientMsgId: String) {
        val upload = find(clientMsgId) ?: return
        // First: an upload that has returned must not be handed to the outbox any more (M1).
        cancelled += clientMsgId
        uploaded.remove(clientMsgId)
        temporaryFailures.remove(clientMsgId)
        synchronized(jobs) {
            jobs.remove(clientMsgId)?.cancel()
            retries.remove(clientMsgId)?.cancel()
        }
        _uploads.update { list -> list.filter { it.pending.clientMsgId != clientMsgId } }
        owners.remove(clientMsgId)
        scope.launch {
            runCatching { store.remove(clientMsgId) }
            runCatching { files.discard(upload.pending.toPicked()) }
        }
        // A later file of the conversation may have waited for this one.
        handOverLater()
    }

    /** The background flush: every queued file goes now, whatever the socket; returns when they settled. */
    suspend fun flush() {
        restore()
        pendingKeys().forEach { launchUpload(it, ignoreConnection = true) }
        synchronized(jobs) { jobs.values.toList() }.joinAll()
        // Everything that is up enters the outbox before the worker sends the outbox.
        handOver()
    }

    /** The engine's store was wiped (rows included): stop and forget the files in memory and on disk. */
    private suspend fun forget() {
        synchronized(jobs) {
            jobs.values.forEach { it.cancel() }
            jobs.clear()
            retries.values.forEach { it.cancel() }
            retries.clear()
        }
        uploaded.clear()
        temporaryFailures.clear()
        _uploads.value = emptyList()
        _handedOver.value = emptyMap()
        owners.clear()
        loaded.withLock {
            restored = false
            // A copy goes with its row: a delete that failed (rows still there) keeps them for the
            // account. Read and prune under the lock that [add] writes a copy and its row under.
            val rows = runCatching { store.all() }.getOrNull() ?: return@withLock
            runCatching { files.pruneKept(rows.mapTo(HashSet()) { it.clientMsgId }) }
        }
    }

    /**
     * A file of [account] goes up (and into the outbox) only while [account] is signed in and the
     * queue is its own, in memory and on disk: never under another account's token, never while a
     * wipe left the queue unnamed. Checked when the upload is launched and again when its job starts,
     * right before the request goes out (the account may have switched in between).
     */
    private fun ownedBy(account: Long): Boolean =
        engine.ready.value && owner() == account && engine.state.value.me == account && engine.ownerOnDisk == account

    /** Explicit sign-out: uploads stop, the kept copies and rows are deleted. */
    suspend fun reset() {
        synchronized(jobs) {
            jobs.values.forEach { it.cancel() }
            jobs.clear()
            retries.values.forEach { it.cancel() }
            retries.clear()
        }
        uploaded.clear()
        temporaryFailures.clear()
        _uploads.value = emptyList()
        _handedOver.value = emptyMap()
        owners.clear()
        runCatching { store.clear() }
        runCatching { files.pruneKept(emptySet()) }
    }

    /** Waiting (not refused, not going up, not up already) files, in the order they were picked. */
    private fun pendingKeys(): List<String> =
        _uploads.value.filter { !it.pending.failed && it.progress == null && !uploaded.containsKey(it.pending.clientMsgId) }
            .sortedBy { it.pending.createdAt }
            .map { it.pending.clientMsgId }

    private fun find(key: String) = _uploads.value.firstOrNull { it.pending.clientMsgId == key }

    private fun replace(pending: PendingUpload, progress: Float? = null) {
        _uploads.update { list -> list.map { if (it.pending.clientMsgId == pending.clientMsgId) Upload(pending, progress) else it } }
    }

    private fun setProgress(key: String, progress: Float?) {
        _uploads.update { list -> list.map { if (it.pending.clientMsgId == key) it.copy(progress = progress) else it } }
    }

    private fun launchUpload(key: String, ignoreConnection: Boolean = false) {
        if (!ignoreConnection && !online) return
        val account = owners[key] ?: return
        if (!ownedBy(account)) return
        val job = synchronized(jobs) {
            if (jobs[key]?.isActive == true) return
            retries.remove(key)?.cancel()
            scope.launch(start = CoroutineStart.LAZY) { upload(key, account) }.also { job ->
                jobs[key] = job
                job.invokeOnCompletion { synchronized(jobs) { if (jobs[key] === job) jobs.remove(key) } }
            }
        }
        job.start()
    }

    private suspend fun upload(key: String, account: Long) {
        if (find(key)?.pending?.failed != false) return
        // The job may start after the account switched (before the old files were forgotten).
        if (!ownedBy(account)) return
        slots.withPermit {
            // Checked again once a slot is free: the file may be gone, refused or another account's now.
            val pending = find(key)?.pending ?: return
            if (pending.failed || !ownedBy(account)) return
            setProgress(key, 0f)
            try {
                // Made for this account: never sent under another one's token (final review I4).
                val done = withContext(RequestOwner(account)) {
                    files.upload(pending.toPicked()) { progress ->
                        val current = find(key)?.progress
                        if (current == null || (current * 100).toInt() != (progress * 100).toInt()) setProgress(key, progress)
                    }
                }
                done.id.toLongOrNull() ?: throw IllegalStateException(UploadRules.REFUSED)
                temporaryFailures.remove(key)
                if (key !in cancelled) uploaded[key] = Uploaded(done, account)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onUploadFailed(pending, e)
                return
            }
        }
        handOver()
    }

    private fun onUploadFailed(pending: PendingUpload, e: Exception) {
        val key = pending.clientMsgId
        val status = (e as? ApiException)?.statusCode
        when {
            // No answer, or the session ended meanwhile: not refused, it waits (and goes again for its account).
            status == 0 || status == 401 -> {
                setProgress(key, null)
                scheduleRetry(key, retryDelayMs)
            }
            status != null && isTemporary(status) -> {
                val failures = temporaryFailures.merge(key, 1, Int::plus) ?: 1
                if (failures >= MAX_ATTEMPTS) {
                    temporaryFailures.remove(key)
                    fail(pending, e)
                } else {
                    setProgress(key, null)
                    val wait = RetryAfter.automaticWaitMs((e as ApiException).retryAfterSeconds) ?: 0L
                    scheduleRetry(key, maxOf(wait, retryDelayMs))
                }
            }
            else -> fail(pending, e)
        }
    }

    /** The server refused the file: it waits for «Повторить» / «Удалить», with the server's reason. */
    private fun fail(pending: PendingUpload, e: Exception) {
        val reason = UploadRules.failureText(e)
        val failed = pending.copy(failed = true, error = reason)
        replace(failed)
        scope.launch { runCatching { store.put(failed) } }
        _notices.tryEmit(pending.conversation to reason)
        // A refused file does not hold up the ones picked after it.
        handOverLater()
    }

    private fun handOverLater() {
        scope.launch { handOver() }
    }

    /**
     * Files that are up enter the outbox in the order they were picked, per conversation: a file waits
     * while an earlier one of its conversation is still going up (or waiting to); refused ones do not
     * count.
     */
    private suspend fun handOver() = handingOver.withLock {
        var progressed = true
        while (progressed) {
            progressed = false
            val waitingFor = HashSet<String>()
            for (item in _uploads.value.sortedBy { it.pending.createdAt }) {
                if (item.pending.failed) continue
                val conversation = item.pending.conversation
                val done = uploaded[item.pending.clientMsgId]
                if (done == null) {
                    waitingFor += conversation
                    continue
                }
                if (conversation in waitingFor) continue
                handOver(item.pending, done)
                progressed = true
                break
            }
        }
    }

    private suspend fun handOver(pending: PendingUpload, up: Uploaded) {
        val key = pending.clientMsgId
        uploaded.remove(key)
        if (key in cancelled) return
        val done = up.response
        val fileId = done.id.toLong()
        val metadata = attachmentMetadata(
            LocalUpload(pending.uri, pending.name, done.fileSize, done.mimeType, pending.width, pending.height),
            fileId
        )
        val outcome = engine.enqueue(
            conversation = pending.conversation,
            text = pending.name,
            msgType = if (Attachments.isImage(pending.name, pending.mimeType)) "image" else "file",
            replyToId = pending.replyToId,
            metadata = metadata,
            clientMsgId = key,
            // Taken only into this account's queue (checked in the engine's command loop)…
            owner = up.account,
            // …and not at all once «Отменить» was pressed, even while this waited for the engine.
            stillWanted = { key !in cancelled }
        )
        if (key in cancelled) {
            // Cancelled after the engine took it: the outbox entry is cancelled too (§7.10).
            if (outcome.persisted) engine.cancel(key)
            return
        }
        if (!outcome.persisted) {
            // The outbox could not be written: the file waits and goes again.
            setProgress(key, null)
            scheduleRetry(key, retryDelayMs)
            return
        }
        owners.remove(key)
        // In the outbox now (or already there after an earlier attempt): the row is not needed.
        if (engine.state.value.outbox.any { it.clientMsgId == key }) {
            _handedOver.update { it + (key to LocalUpload(pending.uri, pending.name, done.fileSize, done.mimeType, pending.width, pending.height, fileId = fileId)) }
        } else {
            runCatching { files.discard(pending.toPicked()) }
        }
        _uploads.update { list -> list.filter { it.pending.clientMsgId != key } }
        runCatching { store.remove(key) }
    }

    private fun scheduleRetry(key: String, delayMs: Long) = synchronized(jobs) {
        retries.remove(key)?.cancel()
        retries[key] = scope.launch {
            delay(delayMs)
            synchronized(jobs) { retries.remove(key) }
            if (online) launchUpload(key)
        }
    }

    companion object {
        /** The server's `MAX_PARALLEL_UPLOADS` per person. */
        const val MAX_PARALLEL = 2

        /** Temporary refusals in a row before a file is failed (as delivery's `MAX_ATTEMPTS`). */
        const val MAX_ATTEMPTS = 5

        /** Statuses that say "not now", not "not this file". */
        fun isTemporary(status: Int): Boolean = status == 408 || status == 429 || status in 500..599
    }
}

internal fun PendingUpload.toPicked() = PickedFile(uri = uri, name = name, size = size, mimeType = mimeType, width = width, height = height)

/** The bubble's local record of a file still on its way. */
internal fun AttachmentSends.Upload.toLocalUpload() = LocalUpload(
    uri = pending.uri,
    name = pending.name,
    size = pending.size,
    mimeType = pending.mimeType,
    width = pending.width,
    height = pending.height,
    progress = progress,
    error = pending.error
)

/** The local record of a picked file, before the server has it. */
internal fun PickedFile.toLocalUpload() = LocalUpload(
    uri = uri, name = name, size = size, mimeType = mimeType, width = width, height = height
)

internal fun LocalUpload.toPicked() = PickedFile(
    uri = uri, name = name, size = size, mimeType = mimeType, width = width, height = height
)

/**
 * `metadata` of the message, as the desktop sends it (App.jsx `handleSendFile`): the server checks
 * `file_id` belongs to me; the rest lets every client draw the tile before it asks for the file.
 */
internal fun attachmentMetadata(upload: LocalUpload, fileId: Long): JsonObject = buildJsonObject {
    put("file_id", fileId)
    upload.size?.let { put("size", it) }
    upload.mimeType?.let { put("mimeType", it) }
    put("url", "/api/files/download/$fileId")
    if (upload.width != null && upload.height != null) {
        put("width", upload.width)
        put("height", upload.height)
    }
}
