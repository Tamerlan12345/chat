package com.openmychat.mobile.features.attachments

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider

/**
 * Hands a downloaded attachment to another app: a `content://` URI from the app's FileProvider
 * (never `file://`), read access granted to that app only, no storage permission.
 */
object AttachmentIntents {
    /**
     * Types another app may be asked to open a file as — exactly the server's `SAFE_DOWNLOAD_TYPES`
     * (server/src/api/index.js `safeDownloadType`, audit R4-14): images without SVG, PDF, plain text,
     * CSV, audio, video, archives. Anything else is `application/octet-stream`.
     */
    val SAFE_TYPES: Set<String> = setOf(
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
        "application/pdf", "text/plain", "text/csv",
        "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/webm",
        "video/mp4", "video/webm", "video/quicktime",
        "application/zip", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed"
    )

    private const val OCTET_STREAM = "application/octet-stream"

    /** Must match the provider in AndroidManifest.xml. */
    fun authority(context: Context): String = "${context.packageName}.attachments"

    /** false — no app on the device opens this type. */
    fun open(context: Context, request: OpenRequest): Boolean {
        val uri = FileProvider.getUriForFile(context, authority(context), request.file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, viewType(request.name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    /**
     * The type apps are matched by. Never the sender's label (any client can write `metadata.mimeType`):
     * the extension's type — extensions are what the admin's file policy allows — kept only when it is
     * on [SAFE_TYPES].
     */
    fun viewType(name: String, typeForExtension: (String) -> String? = ::systemType): String {
        val ext = Attachments.extensionOf(name)
        if (ext.isEmpty()) return OCTET_STREAM
        val type = typeForExtension(ext)?.substringBefore(';')?.trim()?.lowercase()
        return if (type != null && type in SAFE_TYPES) type else OCTET_STREAM
    }

    private fun systemType(extension: String): String? = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
}
