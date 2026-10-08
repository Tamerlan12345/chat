package com.openmychat.mobile.features.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.ReportTargetType
import com.openmychat.mobile.ui.components.CentyPrimaryButton
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.components.centyFieldColors
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.features.auth.rememberClock
import androidx.compose.runtime.getValue

/** «Пожаловаться» as a bottom sheet over the person card or the chat. Closing it while sending is not possible. */
@Composable
fun ReportSheet(controller: ReportController, sheet: ReportSheetState) {
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { !sheet.sending }
    )
    ModalBottomSheet(
        onDismissRequest = controller::dismiss,
        sheetState = sheetState,
        containerColor = CentyTheme.tokens.elevated
    ) {
        ReportSheetContent(
            sheet = sheet,
            onReason = controller::selectReason,
            onDetails = controller::updateDetails,
            onSend = controller::send,
            onClose = controller::dismiss
        )
    }
}

@Composable
fun ReportSheetContent(
    sheet: ReportSheetState,
    onReason: (ReportReason) -> Unit,
    onDetails: (String) -> Unit,
    onSend: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = CentyTheme.tokens
    // Ticks every second: a server wait (429) counts down and «Отправить жалобу» comes back at 0.
    val now by rememberClock()
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .navigationBarsPadding()
            .padding(horizontal = 16.dp)
            .padding(bottom = 16.dp)
            .testTag("report-sheet"),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            stringResource(if (sheet.target.type == ReportTargetType.MESSAGE) R.string.report_title_message else R.string.report_title_user),
            style = MaterialTheme.typography.titleLarge,
            color = tokens.textStrong,
            modifier = Modifier.semantics { heading() }
        )
        if (sheet.sent) {
            SentState(onClose)
            return@Column
        }
        Label(stringResource(R.string.report_subject))
        Text(
            sheet.target.subject,
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis
        )
        Label(stringResource(R.string.report_reason))
        Column(Modifier.selectableGroup()) {
            ReportReason.entries.forEach { reason ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .selectable(
                            selected = sheet.reason == reason,
                            enabled = !sheet.sending,
                            role = Role.RadioButton,
                            onClick = { onReason(reason) }
                        )
                        // Two-line titles at large font sizes keep apart from their neighbours.
                        .padding(vertical = 4.dp)
                        .testTag("report-reason-${reason.code}"),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    RadioButton(
                        selected = sheet.reason == reason,
                        onClick = null,
                        colors = RadioButtonDefaults.colors(selectedColor = tokens.accentText)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(reasonTitle(reason), style = MaterialTheme.typography.bodyLarge, color = tokens.textStrong)
                }
            }
        }
        OutlinedTextField(
            value = sheet.details,
            onValueChange = onDetails,
            label = { Text(stringResource(R.string.report_details)) },
            enabled = !sheet.sending,
            minLines = 2,
            maxLines = 6,
            shape = RoundedCornerShape(CentyRadius.control),
            colors = centyFieldColors(),
            supportingText = { Text(stringResource(R.string.report_footer)) },
            modifier = Modifier.fillMaxWidth().testTag("report-details")
        )
        sheet.failure?.let { failure ->
            accountFailureText(failure, now)?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = tokens.dangerText,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("report-error")
                )
            }
        }
        CentyPrimaryButton(
            text = stringResource(R.string.report_send),
            onClick = onSend,
            enabled = sheet.canSendAt(now) || sheet.sending,
            loading = sheet.sending,
            loadingDescription = stringResource(R.string.report_sending),
            modifier = Modifier.fillMaxWidth().testTag("report-submit")
        )
        CentyTextButton(onClick = onClose, enabled = !sheet.sending, modifier = Modifier.fillMaxWidth().testTag("report-cancel")) {
            Text(stringResource(R.string.action_cancel))
        }
    }
}

@Composable
private fun SentState(onClose: () -> Unit) {
    val tokens = CentyTheme.tokens
    Column(
        Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("report-sent"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = tokens.successText, modifier = Modifier.size(52.dp))
        Text(stringResource(R.string.report_sent_title), style = MaterialTheme.typography.titleMedium, color = tokens.textStrong)
        Text(
            stringResource(R.string.report_sent_message),
            style = MaterialTheme.typography.bodyMedium,
            color = tokens.textSecondary,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.size(4.dp))
        CentyPrimaryButton(
            text = stringResource(R.string.action_close),
            onClick = onClose,
            modifier = Modifier.fillMaxWidth().testTag("report-close")
        )
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = CentyTheme.tokens.textSecondary, modifier = Modifier.semantics { heading() })
}

@Composable
private fun reasonTitle(reason: ReportReason): String = stringResource(
    when (reason) {
        ReportReason.SPAM -> R.string.report_reason_spam
        ReportReason.ABUSE -> R.string.report_reason_abuse
        ReportReason.INAPPROPRIATE -> R.string.report_reason_inappropriate
        ReportReason.THREAT -> R.string.report_reason_threat
        ReportReason.OTHER -> R.string.report_reason_other
    }
)
