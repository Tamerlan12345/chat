package com.openmychat.mobile.features.attachments

import com.openmychat.mobile.core.network.ApiException
import com.openmychat.mobile.data.repository.AttachmentRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/** Where the download of one attachment stands, for its tile and the image viewer. */
sealed interface TransferState {
    /** [progress] 0..1, null while the size is unknown. */
    data class Running(val progress: Float?) : TransferState
    data class Failed(val message: String) : TransferState
    data class Ready(val file: File) : TransferState
}

/** A downloaded file to hand to another app (`ACTION_VIEW` through the FileProvider). */
data class OpenRequest(val file: File, val name: String, val mimeType: String?)

/**
 * A tap on an attachment: an image opens in the in-app viewer (thumbnail first, the full picture
 * downloads under it); any other file downloads into the app cache, its progress and failure on the
 * tile, and is then handed to another app. A second tap while it downloads does nothing; after a
 * failure it tries again (and resumes).
 */
class AttachmentOpener(
    private val repository: AttachmentRepository,
    private val scope: CoroutineScope,
    /** Russian snackbar text when a file could not be downloaded. */
    private val notify: (String) -> Unit
) {
    private val _transfers = MutableStateFlow<Map<Long, TransferState>>(emptyMap())
    val transfers: StateFlow<Map<Long, TransferState>> = _transfers.asStateFlow()

    private val _viewer = MutableStateFlow<MessageAttachment?>(null)

    /** The image shown full screen; null — the viewer is closed. */
    val viewer: StateFlow<MessageAttachment?> = _viewer.asStateFlow()

    private val requests = Channel<OpenRequest>(Channel.BUFFERED)

    /** Each downloaded file to open, once. */
    val openRequests: Flow<OpenRequest> = requests.receiveAsFlow()

    fun open(attachment: MessageAttachment) {
        if (attachment.fileId == null) return
        if (attachment.isImage) {
            _viewer.value = attachment
            if (_transfers.value[attachment.fileId] !is TransferState.Ready) fetch(attachment, openWhenReady = false)
        } else {
            fetch(attachment, openWhenReady = true)
        }
    }

    /** «Повторить» in the viewer. */
    fun retry(attachment: MessageAttachment) {
        if (attachment.fileId != null) fetch(attachment, openWhenReady = !attachment.isImage)
    }

    fun closeViewer() {
        _viewer.value = null
    }

    fun thumbnailUrl(attachment: MessageAttachment): String? = attachment.fileId?.let(repository::thumbnailUrl)

    private fun fetch(attachment: MessageAttachment, openWhenReady: Boolean) {
        val id = attachment.fileId ?: return
        if (_transfers.value[id] is TransferState.Running) return
        set(id, TransferState.Running(null))
        scope.launch {
            try {
                val file = repository.download(id, attachment.name) { progress -> set(id, TransferState.Running(progress)) }
                set(id, TransferState.Ready(file))
                if (openWhenReady) requests.trySend(OpenRequest(file, attachment.name, attachment.mimeType))
            } catch (e: CancellationException) {
                _transfers.update { it - id }
                throw e
            } catch (e: Exception) {
                val reason = when (e) {
                    is AttachmentException -> e.message
                    is ApiException -> if (e.statusCode == 0) AttachmentDownloader.NO_NETWORK else e.message
                    else -> null
                }?.takeIf { it.isNotBlank() } ?: FAILED
                set(id, TransferState.Failed(reason))
                if (!attachment.isImage) notify(reason)
            }
        }
    }

    private fun set(id: Long, state: TransferState) {
        _transfers.update { it + (id to state) }
    }

    private companion object {
        const val FAILED = "Не удалось скачать файл"
    }
}
