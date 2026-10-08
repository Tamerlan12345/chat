package com.openmychat.mobile.features.attachments

import android.net.Uri
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * The system pickers: the Photo Picker for pictures and `OpenDocument` for any file. Neither needs a
 * storage permission; the app reads only what was picked.
 */
class AttachmentPickers internal constructor(
    private val photo: ManagedActivityResultLauncher<PickVisualMediaRequest, Uri?>,
    private val document: ManagedActivityResultLauncher<Array<String>, Uri?>
) {
    fun pickPhoto() = photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))

    /** Any type: the admin's policy is checked with the server's wording once the file is chosen. */
    fun pickFile() = document.launch(arrayOf("*/*"))
}

@Composable
fun rememberAttachmentPickers(onPicked: (Uri) -> Unit): AttachmentPickers {
    val latest = rememberUpdatedState(onPicked)
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let { latest.value(it) } }
    val document = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { latest.value(it) } }
    return remember(photo, document) { AttachmentPickers(photo, document) }
}

/** «Прикрепить»: a photo from the gallery or any file. */
@Composable
fun AttachmentChooserSheet(onPhoto: () -> Unit, onFile: () -> Unit, onDismiss: () -> Unit) {
    val tokens = CentyTheme.tokens
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = tokens.elevated
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Text(
                stringResource(R.string.attachment_pick_title),
                style = MaterialTheme.typography.titleMedium,
                color = tokens.textStrong,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() }
            )
            ChooserRow(Icons.Outlined.Image, stringResource(R.string.attachment_pick_photo), stringResource(R.string.attachment_pick_photo_hint), "attach-photo", onPhoto)
            ChooserRow(Icons.Outlined.Description, stringResource(R.string.attachment_pick_file), stringResource(R.string.attachment_pick_file_hint), "attach-file", onFile)
        }
    }
}

@Composable
private fun ChooserRow(icon: ImageVector, title: String, hint: String, tag: String, onClick: () -> Unit) {
    val tokens = CentyTheme.tokens
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Box(Modifier.size(40.dp).background(tokens.primarySoft, RoundedCornerShape(CentyRadius.control)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tokens.accentText)
        }
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = tokens.textMain)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = tokens.textSecondary)
        }
    }
}
