package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.data.model.AnnouncementPriority
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Importance of an announcement: a 6 dp dot and its label, never a coloured border or a boxed badge
 * (polish pass, rule 8). «Критично» danger, «Срочно» warning, «Оповещение» neutral, as on desktop.
 */
@Composable
fun PriorityMarker(
    priority: AnnouncementPriority,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.labelSmall
) {
    val tokens = CentyTheme.tokens
    val (dot: Color, text: Color, label: Int) = when (priority) {
        AnnouncementPriority.NORMAL -> Triple(tokens.offline, tokens.textDim, R.string.priority_normal)
        AnnouncementPriority.URGENT -> Triple(tokens.warning, tokens.warningText, R.string.priority_urgent)
        AnnouncementPriority.CRITICAL -> Triple(tokens.danger, tokens.dangerText, R.string.priority_critical)
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(6.dp).background(dot, CircleShape))
        Text(stringResource(label), color = text, style = style, maxLines = 1)
    }
}
