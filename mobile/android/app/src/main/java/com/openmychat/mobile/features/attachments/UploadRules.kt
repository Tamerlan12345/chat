package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.model.FilePolicy

/**
 * What can be sent, checked before the upload with the server's own wording, and the server's
 * refusals in its own words (server: `acceptUpload`, `FilePolicyService.check`).
 */
object UploadRules {
    /** The server's hard ceiling (`UPLOAD_LIMIT_BYTES`); the admin's own limit is reported by the server. */
    const val MAX_BYTES = 100L * 1024 * 1024

    /** null — may be sent; otherwise the reason. [policy] null — unknown (the server still checks). */
    fun problem(name: String, size: Long?, policy: FilePolicy?): String? {
        if (size == 0L) return "Файл пустой"
        if (size != null && size > MAX_BYTES) return "Файл больше 100 МБ — такой файл загрузить нельзя"
        if (policy == null || !policy.enabled) return null
        val ext = Attachments.extensionOf(name)
        if (ext.isEmpty()) return "У файла нет расширения"
        val allowed = policy.allowed.map { it.trim().removePrefix(".").lowercase() }
        if (ext !in allowed) return "Файлы .$ext к отправке не разрешены"
        return null
    }

    /** The reason an upload failed, for the bubble and the snackbar. */
    fun failureText(error: Throwable): String = when {
        error is AttachmentException -> error.message ?: REFUSED
        error !is ApiException -> REFUSED
        error.statusCode == 0 -> NO_NETWORK
        error.message.isNullOrBlank() || error.message!!.startsWith("HTTP error") -> REFUSED
        else -> error.message!!
    }

    const val NO_NETWORK = "Нет связи с сервером"
    const val REFUSED = "Сервер не принял файл"
}
