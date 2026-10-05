package com.openmychat.mobile.features.attachments

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.LocalUpload
import com.openmychat.mobile.ui.components.FileAttachmentTile
import com.openmychat.mobile.ui.components.ImageAttachmentTile
import com.openmychat.mobile.ui.components.attachmentKind
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * The attachment inside a bubble. An image: its thumbnail from the server (the picked picture while
 * it uploads) in a frame of the right proportions. A file: its tile with size, upload or download
 * progress, or the reason it failed. [modifier] carries the row's tap (open) and long press (menu).
 */
@Composable
internal fun MessageAttachmentView(
    attachment: MessageAttachment,
    upload: LocalUpload?,
    transfer: TransferState?,
    thumbnailUrl: String?,
    sizeLabel: String?,
    modifier: Modifier = Modifier,
    onCancelUpload: (() -> Unit)? = null
) {
    val uploading = upload?.progress?.takeIf { upload.fileId == null }
    // Set only when the server refused the file; a retry clears it.
    val refusal = upload?.error
    if (attachment.isImage) {
        Column {
            val model: Any? = attachment.localUri ?: thumbnailUrl
            var loaded by remember(model) { mutableStateOf(false) }
            ImageAttachmentTile(
                aspectRatio = aspectRatio(attachment),
                modifier = modifier,
                loaded = loaded,
                progress = uploading,
                onCancel = onCancelUpload.takeIf { uploading != null },
                image = model?.let {
                    {
                        AsyncImage(
                            model = it,
                            contentDescription = stringResource(R.string.viewer_image, attachment.name),
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                            onSuccess = { loaded = true }
                        )
                    }
                }
            )
            if (refusal != null) {
                Text(
                    refusal,
                    style = MaterialTheme.typography.labelMedium,
                    color = CentyTheme.tokens.dangerText,
                    modifier = Modifier.widthIn(max = 260.dp).padding(top = 4.dp)
                )
            }
        }
    } else {
        val downloading = transfer as? TransferState.Running
        val status: String? = when {
            refusal != null -> refusal
            uploading != null -> null
            downloading != null -> downloading.progress?.let { stringResource(R.string.attachment_downloading, (it * 100).toInt()) }
                ?: stringResource(R.string.attachment_download_waiting)
            transfer is TransferState.Failed -> transfer.message
            else -> null
        }
        FileAttachmentTile(
            name = attachment.name,
            sizeLabel = sizeLabel,
            modifier = modifier,
            kind = attachmentKind(attachment.name, attachment.mimeType),
            progress = uploading ?: downloading?.let { it.progress ?: 0f },
            failed = refusal != null,
            status = status,
            statusIsError = refusal != null || transfer is TransferState.Failed,
            onCancel = onCancelUpload.takeIf { uploading != null }
        )
    }
}

/** The frame keeps the picture's proportions (4:3 until they are known), within 1:2…2:1. */
internal fun aspectRatio(attachment: MessageAttachment): Float {
    val w = attachment.width ?: 0
    val h = attachment.height ?: 0
    return if (w > 0 && h > 0) w.toFloat() / h else 4f / 3f
}
