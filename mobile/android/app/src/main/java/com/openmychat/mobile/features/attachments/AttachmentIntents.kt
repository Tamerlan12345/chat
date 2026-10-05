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
    /** Must match the provider in AndroidManifest.xml. */
    fun authority(context: Context): String = "${context.packageName}.attachments"

    /** false — no app on the device opens this type. */
    fun open(context: Context, request: OpenRequest): Boolean {
        val uri = FileProvider.getUriForFile(context, authority(context), request.file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, viewType(request.name, request.mimeType))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    /**
     * The type apps are matched by: the sender's, unless it says nothing (octet-stream), then by the
     * extension, else any.
     */
    fun viewType(name: String, mimeType: String?): String {
        mimeType?.trim()?.lowercase()?.takeIf { it.isNotEmpty() && it != "application/octet-stream" && '/' in it }?.let { return it }
        val ext = Attachments.extensionOf(name)
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
    }
}
