package com.openmychat.mobile.features.chat

import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.data.repository.PickedFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Uploads in flight, by send key: one per message, cancellable. */
internal class UploadJobs {
    private val jobs = HashMap<String, Job>()

    fun isRunning(key: String): Boolean = jobs[key]?.isActive == true

    fun start(key: String, scope: CoroutineScope, block: suspend () -> Unit) {
        val job = scope.launch(start = CoroutineStart.LAZY) { block() }
        jobs[key] = job
        job.invokeOnCompletion { if (jobs[key] === job) jobs.remove(key) }
        job.start()
    }

    fun cancel(key: String) {
        jobs.remove(key)?.cancel()
    }
}

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
