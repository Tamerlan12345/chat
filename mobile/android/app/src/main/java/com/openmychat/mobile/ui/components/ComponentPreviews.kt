package com.openmychat.mobile.ui.components

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.model.AnnouncementPriority
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.theme.CentyChatTheme
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * The component library at a glance, light and dark. Static (reduce motion on) so previews and
 * screenshot tools render a stable frame.
 */
@Preview(name = "Components · light", widthDp = 360)
@Preview(name = "Components · dark", widthDp = 360, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun ComponentsPreview() {
    CentyChatTheme(reduceMotion = true) {
        Column(
            Modifier.background(CentyTheme.tokens.list).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                CentyAvatar("Алиса Тестова", status = UserStatus.ONLINE)
                CentyAvatar("Боб Тестов", status = UserStatus.AWAY)
                CentyAvatar("Администратор системы", status = UserStatus.DND)
                CentyAvatar("mobile-dev", isChannel = true)
                StatusDot(UserStatus.OFFLINE)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                UnreadPill(3)
                UnreadPill(128)
                DeliveryGlyph(DeliveryMark.QUEUED)
                DeliveryGlyph(DeliveryMark.SENT)
                DeliveryGlyph(DeliveryMark.DELIVERED)
                DeliveryGlyph(DeliveryMark.READ)
                DeliveryGlyph(DeliveryMark.FAILED)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PriorityMarker(AnnouncementPriority.NORMAL)
                PriorityMarker(AnnouncementPriority.URGENT)
                PriorityMarker(AnnouncementPriority.CRITICAL)
            }
            TypingIndicator("печатает")
            InlineNotice("Не удалось обновить список чатов", actionLabel = "Повторить", onAction = {})
            ConnectionBanner(ConnectionState.Connecting, graceMillis = 0, networkAvailable = true)
            ConnectionBanner(ConnectionState.Disconnected, graceMillis = 0, networkAvailable = false)
        }
    }
}

@Preview(name = "States · light", widthDp = 360, heightDp = 420)
@Preview(name = "States · dark", widthDp = 360, heightDp = 420, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun StatesPreview() {
    CentyChatTheme(reduceMotion = true) {
        Column(Modifier.background(CentyTheme.tokens.list)) {
            Column(Modifier.height(210.dp)) {
                EmptyState("Пока нет диалогов", icon = Icons.Outlined.Forum, message = "Диалоги появятся здесь.")
            }
            Column(Modifier.height(210.dp)) { ErrorState("Не удалось загрузить чаты", onRetry = {}) }
        }
    }
}

@Preview(name = "Skeletons", widthDp = 360, heightDp = 360)
@Composable
private fun SkeletonPreview() {
    CentyChatTheme(reduceMotion = true) {
        Row(Modifier.background(CentyTheme.tokens.list)) {
            Column(Modifier.width(180.dp)) { ConversationSkeleton(rows = 4) }
            Column(Modifier.width(180.dp)) { ChatSkeleton() }
        }
    }
}
