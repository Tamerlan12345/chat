package com.openmychat.mobile.features.attachments

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream

/** One answer of `GET /api/files/download/{id}`. */
class DownloadResponse(
    val code: Int,
    val etag: String?,
    /** Length of this body (the range for a 206). */
    val contentLength: Long?,
    /** `bytes start-end/size` of a 206, `bytes * /size` of a 416. */
    val contentRange: String?,
    val body: InputStream?,
    /** Body of a refusal: plain text (`Файл не найден`) or JSON with `error`. */
    val errorText: String? = null
) : Closeable {
    override fun close() {
        body?.close()
    }
}

/** The HTTP request, blocking. Throws [IOException] when the server cannot be reached. */
fun interface DownloadTransport {
    fun get(fileId: Long, rangeFrom: Long?, ifRange: String?, ifNoneMatch: String?): DownloadResponse
}

/** A download or upload that did not work out; [message] is Russian and ready for the screen. */
class AttachmentException(message: String) : Exception(message)

/**
 * Downloads an attachment into the app cache (never shared storage), one folder per file id:
 * the file under its own (sanitised) name, a `.part` while it arrives and the server's `.etag`.
 *
 * Resume (openapi.yaml `/files/download/{id}`): a partial with a known ETag continues with
 * `Range: bytes=<have>-` + `If-Range: <etag>` (206 appends; 200 means the file changed — start over;
 * 416 — drop the partial and ask again). A finished copy is revalidated with `If-None-Match` (304
 * keeps it) and opens offline when the server cannot be reached.
 */
class AttachmentDownloader(private val root: File, private val transport: DownloadTransport) {

    /**
     * Blocking. [onProgress] gets 0..1 (null when the size is unknown); [ensureActive] is called
     * between chunks so a cancelled caller stops the transfer and keeps the partial for later.
     */
    fun fetch(
        fileId: Long,
        name: String,
        onProgress: (Float?) -> Unit = {},
        ensureActive: () -> Unit = {}
    ): File = fetch(fileId, name, onProgress, ensureActive, retried = false)

    private fun fetch(fileId: Long, name: String, onProgress: (Float?) -> Unit, ensureActive: () -> Unit, retried: Boolean): File {
        val dir = File(root, fileId.toString()).apply { mkdirs() }
        val target = File(dir, safeName(name))
        val part = File(dir, PART)
        val tag = File(dir, ETAG)
        val etag = tag.takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.isNotEmpty() }
        val cached = etag != null && target.isFile
        val resumeFrom = if (!cached && etag != null && part.isFile && part.length() > 0) part.length() else null
        if (!cached && resumeFrom == null) part.delete()

        val response = try {
            transport.get(
                fileId = fileId,
                rangeFrom = resumeFrom,
                ifRange = if (resumeFrom != null) etag else null,
                ifNoneMatch = if (cached) etag else null
            )
        } catch (e: IOException) {
            if (cached) return target
            throw AttachmentException(NO_NETWORK)
        }
        response.use {
            when (it.code) {
                304 -> if (cached) return target
                200 -> return write(it, dir, target, part, tag, offset = 0, onProgress, ensureActive)
                206 -> if (resumeFrom != null) {
                    if (startOf(it.contentRange) == resumeFrom) return write(it, dir, target, part, tag, offset = resumeFrom, onProgress, ensureActive)
                    // Not the range asked for (a proxy, a changed file): appending would corrupt the
                    // copy. Drop the partial and download it whole once.
                    if (!retried) {
                        part.delete()
                        tag.delete()
                        it.close()
                        return fetch(fileId, name, onProgress, ensureActive, retried = true)
                    }
                }
                416 -> if (!retried) {
                    part.delete()
                    tag.delete()
                    return fetch(fileId, name, onProgress, ensureActive, retried = true)
                }
                in 500..599 -> if (cached) return target
                403, 404 -> dir.deleteRecursively()
            }
            throw AttachmentException(refusalText(it))
        }
    }

    private fun write(
        response: DownloadResponse,
        dir: File,
        target: File,
        part: File,
        tag: File,
        offset: Long,
        onProgress: (Float?) -> Unit,
        ensureActive: () -> Unit
    ): File {
        val body = response.body ?: throw AttachmentException(INTERRUPTED)
        val total = if (offset > 0) totalOf(response.contentRange) ?: response.contentLength?.plus(offset) else response.contentLength
        // A whole body replaces whatever was here: the old copy and an unrelated partial.
        if (offset == 0L) dir.listFiles()?.forEach { if (it.name != ETAG) it.delete() }
        if (response.etag != null) tag.writeText(response.etag) else tag.delete()

        var written = offset
        try {
            FileOutputStream(part, offset > 0).use { out ->
                val buffer = ByteArray(BUFFER)
                var lastStep = -1
                onProgress(total?.let { (written.toFloat() / it).coerceIn(0f, 1f) })
                while (true) {
                    ensureActive()
                    val read = body.read(buffer)
                    if (read < 0) break
                    out.write(buffer, 0, read)
                    written += read
                    if (total != null && total > 0) {
                        val step = (written * 100 / total).toInt()
                        if (step != lastStep) {
                            lastStep = step
                            onProgress((written.toFloat() / total).coerceIn(0f, 1f))
                        }
                    }
                }
            }
        } catch (e: IOException) {
            // What arrived stays as the partial; the next tap continues from there.
            throw AttachmentException(INTERRUPTED)
        }
        if (total != null && written != total) throw AttachmentException(INTERRUPTED)
        target.delete()
        if (!part.renameTo(target)) {
            part.copyTo(target, overwrite = true)
            part.delete()
        }
        onProgress(1f)
        return target
    }

    private fun refusalText(response: DownloadResponse): String {
        val raw = response.errorText?.trim().orEmpty()
        val fromJson = if (raw.startsWith("{")) {
            runCatching { (json.parseToJsonElement(raw).jsonObject["error"] as? JsonPrimitive)?.content }.getOrNull()
        } else null
        val text = fromJson ?: raw.takeIf { it.isNotEmpty() && !it.startsWith("{") && !it.startsWith("<") && it.length <= 300 }
        return text ?: when (response.code) {
            403 -> "Нет доступа к файлу"
            404 -> "Файл не найден"
            else -> "Не удалось скачать файл (код ${response.code})"
        }
    }

    companion object {
        const val NO_NETWORK = "Нет связи с сервером — файл не скачан"
        const val INTERRUPTED = "Связь прервалась — нажмите ещё раз, загрузка продолжится"
        private const val PART = ".part"
        private const val ETAG = ".etag"
        private const val BUFFER = 64 * 1024
        private const val MAX_NAME = 120
        private val json = Json { ignoreUnknownKeys = true }
        private val UNSAFE = Regex("[\\\\/:*?\"<>|\\p{Cntrl}]")

        /** A file name that stays inside its folder and is never one of the service files. */
        fun safeName(name: String): String {
            var clean = UNSAFE.replace(name.trim(), "_")
            if (clean.isBlank() || clean.all { it == '.' }) clean = "файл"
            if (clean.startsWith(".")) clean = "_$clean"
            if (clean.length > MAX_NAME) {
                val ext = clean.substringAfterLast('.', "").take(16)
                clean = if (ext.isNotEmpty()) clean.take(MAX_NAME - ext.length - 1) + "." + ext else clean.take(MAX_NAME)
            }
            return clean
        }

        /** First byte of `bytes 100-199/1000`. */
        private fun startOf(contentRange: String?): Long? =
            contentRange?.trim()?.removePrefix("bytes")?.trim()?.substringBefore('-')?.trim()?.toLongOrNull()

        /** Total size from `bytes 100-199/1000`. */
        private fun totalOf(contentRange: String?): Long? =
            contentRange?.substringAfterLast('/', "")?.trim()?.toLongOrNull()
    }
}
