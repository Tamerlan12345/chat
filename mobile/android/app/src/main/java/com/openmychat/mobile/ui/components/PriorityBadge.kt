package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmychat.mobile.data.model.AnnouncementPriority

@Composable
fun PriorityBadge(
    priority: AnnouncementPriority,
    modifier: Modifier = Modifier
) {
    val (bgColor, textColor, label) = when (priority) {
        AnnouncementPriority.NORMAL -> Triple(
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
            "Обычное"
        )
        AnnouncementPriority.URGENT -> Triple(
            Color(0xFFFFF3E0),
            Color(0xFFE65100),
            "Срочное"
        )
        AnnouncementPriority.CRITICAL -> Triple(
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
            "Критическое"
        )
    }

    Text(
        text = label,
        color = textColor,
        fontSize = 11.sp,
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(bgColor)
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}
