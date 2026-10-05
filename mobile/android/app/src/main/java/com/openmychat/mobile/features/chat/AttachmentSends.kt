package com.openmychat.mobile.features.chat

import com.openmychat.mobile.core.network.ApiException
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
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Files on their way into the outbox. A picked file is kept as the app's private copy and recorded
 * in [UploadStore] before anything else happens (so it survives process death), goes up over HTTP
 * when there is a connection (the foreground socket, or a background flush), and only then enters the
 * delivery outbox as a `file`/`image` message with the same `client_msg_id` (delivery-state.md §3.1).
 *
 * A network failure leaves the file queued (it goes again by itself); the server's refusal fails it
 * with the server's reason («Повторить» / «Удалить»). Cancelling stops the upload and forgets the file.
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
    private val loaded = Mutex()
    private var restored = false
    @Volatile private var online = false
    private var started = false

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
        val stored = runCatching { store.all() }.getOrDefault(emptyList())
        _uploads.value = stored.map { Upload(it) }
        // A copy is needed only while its file waits to go up; the rest are left from a past process.
        runCatching { files.pruneKept(stored.mapTo(HashSet()) { it.clientMsgId }) }
    }

    /**
     * Keeps [picked] for [conversation] (a private copy and a stored row) and starts it when online.
     * False when the file could not be kept: nothing was queued.
     */
    suspend fun add(conversation: String, picked: PickedFile, replyToId: Long?): Boolean {
        // A row is written only under its account's name on disk.
        val account = owner() ?: return false
        if (!engine.ready.value || engine.ownerOnDisk != account) return false
        restore()
        val key = DeliveryEngine.newClientMsgId()
        val kept = runCatching { files.keep(picked, key) }.getOrNull() ?: return false
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
            return false
        }
        _uploads.update { it + Upload(pending) }
        if (online) launchUpload(key)
        return true
    }

    /** «Повторить» on a refused file: it goes up again (the server's reason is cleared). */
    fun retry(clientMsgId: String) {
        val upload = find(clientMsgId) ?: return
        if (!upload.pending.failed) return
        val again = upload.pending.copy(failed = false, error = null)
        replace(again)
        scope.launch { runCatching { store.put(again) } }
        launchUpload(clientMsgId, ignoreConnection = true)
    }

    /** «Отменить» / «Удалить»: the upload stops and the file is forgotten. */
    fun cancel(clientMsgId: String) {
        val upload = find(clientMsgId) ?: return
        synchronized(jobs) {
            jobs.remove(clientMsgId)?.cancel()
            retries.remove(clientMsgId)?.cancel()
        }
        _uploads.update { list -> list.filter { it.pending.clientMsgId != clientMsgId } }
        scope.launch {
            runCatching { store.remove(clientMsgId) }
            runCatching { files.discard(upload.pending.toPicked()) }
        }
    }

    /** The background flush: every queued file goes now, whatever the socket; returns when they settled. */
    suspend fun flush() {
        restore()
        pendingKeys().forEach { launchUpload(it, ignoreConnection = true) }
        synchronized(jobs) { jobs.values.toList() }.joinAll()
    }

    /** The engine's store was wiped (rows included): stop and forget the files in memory and on disk. */
    private suspend fun forget() {
        synchronized(jobs) {
            jobs.values.forEach { it.cancel() }
            jobs.clear()
            retries.values.forEach { it.cancel() }
            retries.clear()
        }
        _uploads.value = emptyList()
        _handedOver.value = emptyMap()
        runCatching { files.pruneKept(emptySet()) }
    }

    /** Files go up only for the account that owns the queue, never under another account's token. */
    private fun ownerSignedIn(): Boolean {
        val user = owner() ?: return false
        val me = engine.state.value.me
        return engine.ready.value && (me == null || me == user)
    }

    /** Explicit sign-out: uploads stop, the kept copies and rows are deleted. */
    suspend fun reset() {
        synchronized(jobs) {
            jobs.values.forEach { it.cancel() }
            jobs.clear()
            retries.values.forEach { it.cancel() }
            retries.clear()
        }
        _uploads.value = emptyList()
        _handedOver.value = emptyMap()
        runCatching { store.clear() }
        runCatching { files.pruneKept(emptySet()) }
    }

    /** Waiting (not refused, not going up) files. */
    private fun pendingKeys(): List<String> =
        _uploads.value.filter { !it.pending.failed && it.progress == null }.map { it.pending.clientMsgId }

    private fun find(key: String) = _uploads.value.firstOrNull { it.pending.clientMsgId == key }

    private fun replace(pending: PendingUpload, progress: Float? = null) {
        _uploads.update { list -> list.map { if (it.pending.clientMsgId == pending.clientMsgId) Upload(pending, progress) else it } }
    }

    private fun setProgress(key: String, progress: Float?) {
        _uploads.update { list -> list.map { if (it.pending.clientMsgId == key) it.copy(progress = progress) else it } }
    }

    private fun launchUpload(key: String, ignoreConnection: Boolean = false) {
        if (!ignoreConnection && !online) return
        if (!ownerSignedIn()) return
        val job = synchronized(jobs) {
            if (jobs[key]?.isActive == true) return
            retries.remove(key)?.cancel()
            scope.launch(start = CoroutineStart.LAZY) { upload(key) }.also { job ->
                jobs[key] = job
                job.invokeOnCompletion { synchronized(jobs) { if (jobs[key] === job) jobs.remove(key) } }
            }
        }
        job.start()
    }

    private suspend fun upload(key: String) {
        val pending = find(key)?.pending ?: return
        if (pending.failed) return
        setProgress(key, 0f)
        try {
            val done = files.upload(pending.toPicked()) { progress ->
                val current = find(key)?.progress
                if (current == null || (current * 100).toInt() != (progress * 100).toInt()) setProgress(key, progress)
            }
            val fileId = done.id.toLongOrNull() ?: throw IllegalStateException(UploadRules.REFUSED)
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
                clientMsgId = key
            )
            if (!outcome.persisted) {
                // The outbox could not be written: the file waits and goes again.
                setProgress(key, null)
                scheduleRetry(key)
                return
            }
            // In the outbox now (or already there after an earlier attempt): the row is not needed.
            if (engine.state.value.outbox.any { it.clientMsgId == key }) {
                _handedOver.update { it + (key to LocalUpload(pending.uri, pending.name, done.fileSize, done.mimeType, pending.width, pending.height, fileId = fileId)) }
            } else {
                runCatching { files.discard(pending.toPicked()) }
            }
            _uploads.update { list -> list.filter { it.pending.clientMsgId != key } }
            runCatching { store.remove(key) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException && e.statusCode == 0) {
                // No answer from the server: the file is not refused, it waits for the connection.
                setProgress(key, null)
                scheduleRetry(key)
                return
            }
            val reason = UploadRules.failureText(e)
            val failed = pending.copy(failed = true, error = reason)
            replace(failed)
            runCatching { store.put(failed) }
            _notices.tryEmit(pending.conversation to reason)
        }
    }

    private fun scheduleRetry(key: String) = synchronized(jobs) {
        retries.remove(key)?.cancel()
        retries[key] = scope.launch {
            delay(retryDelayMs)
            synchronized(jobs) { retries.remove(key) }
            if (online) launchUpload(key)
        }
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
