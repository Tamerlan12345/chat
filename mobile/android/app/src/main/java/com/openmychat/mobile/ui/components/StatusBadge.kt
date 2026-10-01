package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.theme.StatusAway
import com.openmychat.mobile.ui.theme.StatusDnd
import com.openmychat.mobile.ui.theme.StatusOffline
import com.openmychat.mobile.ui.theme.StatusOnline

@Composable
fun StatusBadge(
    status: UserStatus,
    modifier: Modifier = Modifier,
    size: Dp = 10.dp,
    borderWidth: Dp = 1.5.dp
) {
    val color = when (status) {
        UserStatus.ONLINE -> StatusOnline
        UserStatus.AWAY -> StatusAway
        UserStatus.DND -> StatusDnd
        UserStatus.OFFLINE -> StatusOffline
    }

    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(color)
            .border(borderWidth, MaterialTheme.colorScheme.surface, CircleShape)
    )
}
