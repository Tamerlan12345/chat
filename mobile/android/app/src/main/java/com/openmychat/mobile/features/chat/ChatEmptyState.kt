package com.openmychat.mobile.features.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.EmptyState
import com.openmychat.mobile.ui.components.Illustration
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * A chat with no messages yet. Open: the illustration and «Напишите первое сообщение». Closed for
 * sending (a block, or the server's `DM_NOT_ALLOWED`): only a quiet «Сообщений нет» — the banner
 * above the composer says why, and nothing invites a message that cannot be sent.
 */
@Composable
internal fun ChatEmptyState(lock: ComposerLock, modifier: Modifier = Modifier) {
    if (lock == ComposerLock.NONE) {
        EmptyState(
            illustration = Illustration.INBOX,
            title = stringResource(R.string.chat_empty),
            message = stringResource(R.string.chat_empty_message),
            modifier = modifier
        )
    } else {
        Box(modifier.fillMaxSize().padding(CentySpace.xxl).testTag("chat-empty-locked"), contentAlignment = Alignment.Center) {
            Text(
                stringResource(R.string.chat_empty_locked),
                style = MaterialTheme.typography.bodyMedium,
                color = CentyTheme.tokens.textDim,
                textAlign = TextAlign.Center
            )
        }
    }
}
