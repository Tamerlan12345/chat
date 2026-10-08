package com.openmychat.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyTextButton
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Why nothing can be sent here: the server's `DM_NOT_ALLOWED` in Russian, or my own block with
 * «Разблокировать». Sits right above the (disabled) composer.
 */
@Composable
internal fun ComposerLockBanner(lock: ComposerLock, onUnblock: () -> Unit) {
    val tokens = CentyTheme.tokens
    // The action sits under the text, so neither is squeezed at large font sizes.
    Column(
        Modifier
            .fillMaxWidth()
            .background(tokens.dangerSoft)
            .padding(start = CentySpace.gutter, end = CentySpace.s, top = CentySpace.m, bottom = if (lock == ComposerLock.BLOCKED_BY_ME) 0.dp else CentySpace.m)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("composer-lock")
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.Block, contentDescription = null, tint = tokens.dangerText, modifier = Modifier.padding(top = 1.dp).size(20.dp))
            Spacer(Modifier.width(CentySpace.m))
            Text(
                stringResource(if (lock == ComposerLock.BLOCKED_BY_ME) R.string.chat_blocked_banner else R.string.chat_dm_not_allowed),
                style = MaterialTheme.typography.bodyMedium,
                color = tokens.dangerText
            )
        }
        if (lock == ComposerLock.BLOCKED_BY_ME) {
            CentyTextButton(onClick = onUnblock, modifier = Modifier.align(Alignment.End).testTag("chat-unblock")) {
                Text(stringResource(R.string.safety_unblock))
            }
        }
    }
}
