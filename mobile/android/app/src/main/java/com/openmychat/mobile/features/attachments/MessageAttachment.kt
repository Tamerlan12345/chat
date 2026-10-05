package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.data.model.MessageType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * The file of a message, from the server's record (`metadata_json`, `file_original_name`,
 * `file_width`) or, before the upload is confirmed, from the file picked on this device.
 */
data class MessageAttachment(
    /** Server id of the file; null until uploaded, or when the metadata cannot be read. */
    val fileId: Long?,
    val name: String,
    val size: Long?,
    val mimeType: String?,
    /** Drawn inline from the server's thumbnail (only formats the server can thumbnail). */
    val isImage: Boolean,
    val width: Int? = null,
    val height: Int? = null,
    /** The picked document, while it is still on its way to the server. */
    val localUri: String? = null
)

object Attachments {
    /** Formats the server thumbnails (by signature): JPEG, PNG, GIF, WebP. */
    private val IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp")
    private val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
    private const val FALLBACK_NAME = "Файл"

    private val json = Json { ignoreUnknownKeys = true }

    fun of(message: Message): MessageAttachment? {
        if (message.isDeleted) return null
        message.upload?.let { upload ->
            return MessageAttachment(
                fileId = upload.fileId,
                name = upload.name,
                size = upload.size,
                mimeType = upload.mimeType,
                isImage = isImage(upload.name, upload.mimeType),
                width = upload.width,
                height = upload.height,
                localUri = upload.uri
            )
        }
        if (message.type == MessageType.TEXT) return null
        val meta = metadata(message.metadataJson)
        val legacy = message.metadata
        val name = message.fileOriginalName?.takeIf { it.isNotBlank() }
            ?: legacy?.fileName?.takeIf { it.isNotBlank() }
            ?: message.text.takeIf { it.isNotBlank() }
            ?: FALLBACK_NAME
        val mime = meta?.string("mimeType") ?: meta?.string("mime_type") ?: legacy?.mimeType
        return MessageAttachment(
            fileId = meta?.long("file_id") ?: legacy?.fileId,
            name = name,
            size = meta?.long("size") ?: legacy?.size,
            mimeType = mime,
            isImage = isImage(name, mime),
            width = message.fileWidth ?: meta?.long("width")?.toInt(),
            height = message.fileHeight ?: meta?.long("height")?.toInt()
        )
    }

    /** The server's rule (FilePolicyService.extensionOf): no dot, a leading dot or a trailing dot → none. */
    fun extensionOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return ""
        return name.substring(dot + 1).lowercase()
    }

    fun isImage(name: String, mimeType: String?): Boolean {
        val ext = extensionOf(name)
        if (ext.isNotEmpty()) return ext in IMAGE_EXTENSIONS
        return mimeType?.lowercase() in IMAGE_TYPES
    }

    private fun metadata(raw: String?): JsonObject? = raw?.takeIf { it.isNotBlank() }?.let {
        runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull()
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

    private fun JsonObject.long(key: String): Long? =
        (this[key] as? JsonPrimitive)?.content?.toDoubleOrNull()?.takeIf { it.isFinite() && it == Math.floor(it) }?.toLong()
}
