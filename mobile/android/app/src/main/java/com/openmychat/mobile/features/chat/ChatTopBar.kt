package com.openmychat.mobile.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.SharedKeys
import com.openmychat.mobile.ui.components.TypingIndicator
import com.openmychat.mobile.ui.components.liftSurface
import com.openmychat.mobile.ui.components.presenceLabel
import com.openmychat.mobile.ui.components.sharedConversationElement
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.CentyRadius
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable

/**
 * The chat header. Flat on the canvas at rest; it lifts to L3 (elevated tone + hairline) while
 * history scrolls under it. The avatar and the name are the shared elements from the inbox row.
 */
@Composable
internal fun ChatTopBar(
    title: String,
    avatarUrl: String?,
    isDirect: Boolean,
    peerStatus: UserStatus?,
    typingUser: String?,
    wakeCooldown: Int,
    showBackButton: Boolean,
    actions: ChatActions,
    lift: State<Float>,
    sharedKey: String?
) {
    val tokens = CentyTheme.tokens
    Column(Modifier.liftSurface(lift, rest = tokens.canvas)) {
        TopAppBar(
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = Color.Transparent,
                scrolledContainerColor = Color.Transparent,
                titleContentColor = tokens.textStrong,
                navigationIconContentColor = tokens.textSecondary,
                actionIconContentColor = tokens.textSecondary
            ),
            navigationIcon = {
                if (showBackButton) {
                    IconButton(onClick = actions::onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                }
            },
            title = {
                val openCard = actions.onOpenCard
                val cardLabel = stringResource(R.string.chat_open_card)
                // В личной переписке аватар и имя открывают карточку собеседника поверх чата.
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = if (openCard != null) {
                        Modifier
                            .clip(RoundedCornerShape(CentyRadius.control))
                            .clickable(onClickLabel = cardLabel, role = Role.Button, onClick = openCard)
                            .padding(end = 8.dp)
                            .testTag("chat-open-card")
                    } else Modifier
                ) {
                    CentyAvatar(
                        name = title,
                        avatarUrl = avatarUrl,
                        status = peerStatus,
                        size = 36.dp,
                        isChannel = !isDirect,
                        ringColor = tokens.canvas,
                        typing = isDirect && typingUser != null,
                        modifier = Modifier.sharedConversationElement(sharedKey?.let(SharedKeys::avatar))
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.semantics(mergeDescendants = true) { heading() }) {
                        Text(
                            title,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.sharedConversationElement(sharedKey?.let(SharedKeys::title))
                        )
                        val typingText = typingUser?.let {
                            if (isDirect) stringResource(R.string.chat_typing) else stringResource(R.string.chat_typing_named, it)
                        }
                        AnimatedContent(
                            targetState = typingText to peerStatus,
                            transitionSpec = { fadeIn(CentyMotion.base()) togetherWith fadeOut(CentyMotion.fast()) },
                            label = "chat-subtitle"
                        ) { (typing, status) ->
                            when {
                                typing != null -> TypingIndicator(typing, style = MaterialTheme.typography.labelMedium)
                                status != null -> Text(
                                    presenceLabel(status),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = tokens.textDim,
                                    maxLines = 1
                                )
                            }
                        }
                    }
                }
            },
            actions = {
                if (isDirect) {
                    val wakeLabel = if (wakeCooldown > 0) {
                        stringResource(R.string.chat_wake_cooldown, wakeCooldown)
                    } else {
                        stringResource(R.string.chat_wake)
                    }
                    IconButton(
                        onClick = actions::onWake,
                        enabled = wakeCooldown == 0,
                        modifier = Modifier.semantics { contentDescription = wakeLabel }
                    ) {
                        if (wakeCooldown > 0) {
                            Text("$wakeCooldown", style = MaterialTheme.typography.labelMedium, color = tokens.textDim)
                        } else {
                            Icon(Icons.Outlined.NotificationsActive, contentDescription = null)
                        }
                    }
                    IconButton(onClick = actions::onCall) {
                        Icon(Icons.Outlined.Call, contentDescription = stringResource(R.string.chat_call))
                    }
                }
            }
        )
    }
}
