package com.openmychat.mobile.core.network

import com.openmychat.mobile.data.model.FileUploadResponse
import com.openmychat.mobile.features.attachments.DownloadResponse
import com.openmychat.mobile.features.attachments.DownloadTransport
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Attachments over HTTP: `POST /api/files/upload` (multipart field `file`, with upload progress and
 * cancellation) and `GET /api/files/download/{id}` with `Range` / `If-Range` / `If-None-Match`.
 *
 * [client] is the app's client: bearer credentials reach only the configured server origin
 * ([BearerCredentialsInterceptor]). [fail] turns a refusal into an [ApiException] with the server's
 * Russian `error` text and applies the session rules (401 ends the session).
 */
class FileTransferClient(
    private val client: OkHttpClient,
    private val apiBaseUrl: () -> String,
    private val fail: (code: Int, body: String, retryAfterSeconds: Long?) -> Nothing
) : DownloadTransport {

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    /** A large file on a slow link may stall longer than an API call between chunks. */
    private val uploadClient: OkHttpClient by lazy {
        client.newBuilder().writeTimeout(2, TimeUnit.MINUTES).readTimeout(2, TimeUnit.MINUTES).build()
    }

    fun thumbnailUrl(fileId: Long): String = "${apiBaseUrl()}/files/thumb/$fileId?size=m"

    /**
     * Uploads [open]'s bytes as [name]. [size] null — unknown (sent chunked). Cancelling the
     * coroutine cancels the request.
     */
    suspend fun upload(
        name: String,
        mimeType: String?,
        size: Long?,
        open: () -> InputStream,
        onProgress: (sent: Long, total: Long?) -> Unit
    ): FileUploadResponse = suspendCancellableCoroutine { continuation ->
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", name, StreamBody((mimeType ?: "application/octet-stream").toMediaTypeOrNull(), size, open, onProgress))
            .build()
        val call = uploadClient.newCall(Request.Builder().url("${apiBaseUrl()}/files/upload").post(body).build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(ApiException(0, "NETWORK_ERROR", e.message ?: "Ошибка сети"))
            }

            override fun onResponse(call: Call, response: Response) {
                val outcome = runCatching {
                    response.use {
                        val text = it.body?.string().orEmpty()
                        if (!it.isSuccessful) fail(it.code, text, it.header("Retry-After")?.trim()?.toLongOrNull())
                        try {
                            json.decodeFromString<FileUploadResponse>(text)
                        } catch (e: Exception) {
                            throw ApiException(it.code, "SERIALIZATION_ERROR", "Сервер не принял файл")
                        }
                    }
                }
                if (!continuation.isActive) return
                outcome.fold(continuation::resume, continuation::resumeWithException)
            }
        })
    }

    override fun get(fileId: Long, rangeFrom: Long?, ifRange: String?, ifNoneMatch: String?): DownloadResponse {
        val request = Request.Builder()
            .url("${apiBaseUrl()}/files/download/$fileId")
            // Byte offsets of a resumed download must be the file's, not a compressed stream's.
            .header("Accept-Encoding", "identity")
            .apply {
                if (rangeFrom != null) header("Range", "bytes=$rangeFrom-")
                if (ifRange != null) header("If-Range", ifRange)
                if (ifNoneMatch != null) header("If-None-Match", ifNoneMatch)
            }
            .get()
            .build()
        val response = client.newCall(request).execute()
        val code = response.code
        if (code == 401) {
            val text = response.use { it.body?.string().orEmpty() }
            fail(code, text, null)
        }
        val streaming = code == 200 || code == 206
        val body = response.body
        return DownloadResponse(
            code = code,
            etag = response.header("ETag"),
            contentLength = body?.contentLength()?.takeIf { it >= 0 },
            contentRange = response.header("Content-Range"),
            body = if (streaming) body?.byteStream() else null,
            errorText = if (streaming) null else response.use { it.body?.source()?.let { s -> s.request(MAX_ERROR); s.buffer.readUtf8(minOf(s.buffer.size, MAX_ERROR)) } }
        ).also { if (!streaming) response.close() }
    }

    /** The picked document, streamed (never loaded whole), reporting how much has gone. */
    private class StreamBody(
        private val type: MediaType?,
        private val size: Long?,
        private val open: () -> InputStream,
        private val onProgress: (Long, Long?) -> Unit
    ) : RequestBody() {
        override fun contentType(): MediaType? = type
        override fun contentLength(): Long = size ?: -1L

        override fun writeTo(sink: BufferedSink) {
            open().use { input ->
                val buffer = ByteArray(64 * 1024)
                var sent = 0L
                onProgress(0, size)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    sink.write(buffer, 0, read)
                    sent += read
                    onProgress(sent, size)
                }
            }
        }
    }

    private companion object {
        const val MAX_ERROR = 4096L
    }
}
