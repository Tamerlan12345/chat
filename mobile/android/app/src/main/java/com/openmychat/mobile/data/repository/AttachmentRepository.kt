package com.openmychat.mobile.data.repository

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.openmychat.mobile.core.network.ApiClient
import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.core.network.FileTransferClient
import com.openmychat.mobile.core.session.SessionManager
import com.openmychat.mobile.data.model.FilePolicy
import com.openmychat.mobile.data.model.FileUploadResponse
import com.openmychat.mobile.di.ApplicationScope
import com.openmychat.mobile.features.attachments.AttachmentDownloader
import com.openmychat.mobile.features.attachments.Attachments
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/** A document picked for sending (system picker: no storage permission). */
data class PickedFile(
    val uri: String,
    val name: String,
    val size: Long?,
    val mimeType: String?,
    val width: Int? = null,
    val height: Int? = null
)

/** Upload, download and policy of attachments. */
interface AttachmentRepository {
    /** Name, size and type of a picked document; null when it cannot be read. */
    suspend fun describe(uri: String): PickedFile?

    /** The admin's file policy for me; null when it could not be loaded (the server still checks). */
    suspend fun policy(): FilePolicy?

    /** Throws [ApiException] with the server's reason; cancelling stops the upload. */
    suspend fun upload(file: PickedFile, onProgress: (Float) -> Unit): FileUploadResponse

    /** The file in the app cache, downloaded or resumed; throws with a Russian reason. */
    suspend fun download(fileId: Long, name: String, onProgress: (Float?) -> Unit): File

    /** Medium thumbnail (480 px) of an image attachment on the configured server. */
    fun thumbnailUrl(fileId: Long): String?
}

/** For previews and tests that never touch files. */
object UnavailableAttachments : AttachmentRepository {
    private fun offline(): Nothing = throw ApiException(0, "NETWORK_ERROR", "No attachment backend")
    override suspend fun describe(uri: String): PickedFile? = null
    override suspend fun policy(): FilePolicy? = null
    override suspend fun upload(file: PickedFile, onProgress: (Float) -> Unit): FileUploadResponse = offline()
    override suspend fun download(fileId: Long, name: String, onProgress: (Float?) -> Unit): File = offline()
    override fun thumbnailUrl(fileId: Long): String? = null
}

@Singleton
class DefaultAttachmentRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    apiClient: ApiClient,
    sessionManager: SessionManager,
    sessionRepository: SessionRepository,
    @ApplicationScope scope: CoroutineScope
) : AttachmentRepository {

    private val transfer = FileTransferClient(
        client = apiClient.imageHttpClient,
        apiBaseUrl = { sessionManager.serverUrl.removeSuffix("/") },
        fail = apiClient::raise
    )
    private val api = apiClient

    /** App cache only: never shared storage, wiped by the system under pressure and by sign-out. */
    private val root = File(context.cacheDir, CACHE_DIR)
    private val downloader = AttachmentDownloader(root, transfer)

    @Volatile private var cachedPolicy: Pair<Long, FilePolicy>? = null

    init {
        // Files of a session never outlive it (like the message history cache).
        scope.launch {
            sessionRepository.token.collect { token ->
                if (token == null) {
                    cachedPolicy = null
                    withContext(Dispatchers.IO) { root.deleteRecursively() }
                }
            }
        }
    }

    override suspend fun describe(uri: String): PickedFile? = withContext(Dispatchers.IO) {
        val parsed = Uri.parse(uri)
        val resolver = context.contentResolver
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                }
            }
        }
        val mime = resolver.getType(parsed)
        var fileName = name?.trim()?.takeIf { it.isNotEmpty() } ?: parsed.lastPathSegment?.substringAfterLast('/') ?: return@withContext null
        // The server needs an extension; a picker name without one gets it from the type.
        if (Attachments.extensionOf(fileName).isEmpty()) {
            MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { fileName = "$fileName.$it" }
        }
        var width: Int? = null
        var height: Int? = null
        if (Attachments.isImage(fileName, mime)) {
            runCatching {
                resolver.openInputStream(parsed)?.use { input ->
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeStream(input, null, bounds)
                    if (bounds.outWidth > 0 && bounds.outHeight > 0) {
                        width = bounds.outWidth
                        height = bounds.outHeight
                    }
                }
            }
        }
        PickedFile(uri = uri, name = fileName, size = size, mimeType = mime, width = width, height = height)
    }

    override suspend fun policy(): FilePolicy? {
        cachedPolicy?.let { (at, policy) -> if (System.currentTimeMillis() - at < POLICY_TTL_MS) return policy }
        return runCatching { api.getFilePolicy() }.getOrNull()?.also { cachedPolicy = System.currentTimeMillis() to it }
    }

    override suspend fun upload(file: PickedFile, onProgress: (Float) -> Unit): FileUploadResponse {
        val resolver = context.contentResolver
        return transfer.upload(
            name = file.name,
            mimeType = file.mimeType,
            size = file.size,
            open = { resolver.openInputStream(Uri.parse(file.uri)) ?: throw IOException("Файл недоступен") }
        ) { sent, total ->
            if (total != null && total > 0) onProgress((sent.toFloat() / total).coerceIn(0f, 1f))
        }
    }

    override suspend fun download(fileId: Long, name: String, onProgress: (Float?) -> Unit): File =
        withContext(Dispatchers.IO) {
            val job = coroutineContext
            downloader.fetch(fileId, name, onProgress = onProgress, ensureActive = { job.ensureActive() })
        }

    override fun thumbnailUrl(fileId: Long): String = transfer.thumbnailUrl(fileId)

    companion object {
        /** Must match `res/xml/attachment_paths.xml`. */
        const val CACHE_DIR = "attachments"
        private const val POLICY_TTL_MS = 5 * 60 * 1000L
    }
}
