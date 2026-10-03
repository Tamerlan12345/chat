package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.LocalFireDepartment
import androidx.compose.material.icons.outlined.PriorityHigh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.AnnouncementPriority
import com.openmychat.mobile.ui.theme.CentyTheme

/** Importance marker, as on desktop: «Срочно» (warning), «Критично» (danger), «Оповещение» (neutral). */
@Composable
fun PriorityBadge(priority: AnnouncementPriority, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(6.dp)
    val background: Color
    val line: Color
    val content: Color
    val icon: ImageVector
    val label: Int
    when (priority) {
        AnnouncementPriority.NORMAL -> {
            background = tokens.hover; line = tokens.border; content = tokens.textSecondary
            icon = Icons.Outlined.Campaign; label = R.string.priority_normal
        }
        AnnouncementPriority.URGENT -> {
            background = tokens.warningSoft; line = tokens.warningLine; content = tokens.warningText
            icon = Icons.Outlined.LocalFireDepartment; label = R.string.priority_urgent
        }
        AnnouncementPriority.CRITICAL -> {
            background = tokens.dangerSoft; line = tokens.dangerLine; content = tokens.dangerText
            icon = Icons.Outlined.PriorityHigh; label = R.string.priority_critical
        }
    }
    Row(
        modifier = modifier
            .background(background, shape)
            .border(1.dp, line, shape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(12.dp))
        Text(stringResource(label), color = content, style = MaterialTheme.typography.labelSmall)
    }
}
