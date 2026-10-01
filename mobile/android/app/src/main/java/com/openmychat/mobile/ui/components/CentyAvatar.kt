package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmychat.mobile.data.model.UserStatus
import kotlin.math.abs

@Composable
fun CentyAvatar(
    name: String,
    modifier: Modifier = Modifier,
    avatarUrl: String? = null,
    status: UserStatus? = null,
    size: Dp = 48.dp
) {
    val initials = name.split(" ")
        .filter { it.isNotBlank() }
        .take(2)
        .mapNotNull { it.firstOrNull()?.uppercase() }
        .joinToString("")
        .ifEmpty { "?" }

    val avatarBackgroundColor = getAvatarColor(name)

    Box(
        modifier = modifier.size(size)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(CircleShape)
                .background(avatarBackgroundColor),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = initials,
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = (size.value * 0.4f).sp
            )
        }

        if (status != null) {
            StatusBadge(
                status = status,
                size = (size.value * 0.28f).coerceAtLeast(10f).dp,
                modifier = Modifier.align(Alignment.BottomEnd)
            )
        }
    }
}

private fun getAvatarColor(name: String): Color {
    val palette = listOf(
        Color(0xFF00677F),
        Color(0xFF00796B),
        Color(0xFF388E3C),
        Color(0xFF5D4037),
        Color(0xFF455A64),
        Color(0xFF512DA8),
        Color(0xFFC2185B),
        Color(0xFF0288D1),
        Color(0xFFE64A19)
    )
    val hash = abs(name.hashCode())
    return palette[hash % palette.size]
}
