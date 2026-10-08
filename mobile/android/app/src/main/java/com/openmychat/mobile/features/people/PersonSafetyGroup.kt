package com.openmychat.mobile.features.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

/** «Пожаловаться» и «Заблокировать» / «Разблокировать» — внизу карточки, отдельно от основных действий. */
@Composable
internal fun PersonSafetyGroup(person: Person, state: PersonCardState, actions: PersonCardActions) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(CentyRadius.card)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tokens.elevated)
            .border(1.dp, tokens.border, shape)
    ) {
        SafetyRow(
            icon = Icons.Outlined.Flag,
            text = stringResource(R.string.safety_report),
            color = tokens.textStrong,
            enabled = true,
            onClick = { actions.onReport(person) },
            tag = "person-report"
        )
        HorizontalDivider(Modifier.padding(start = 52.dp), color = tokens.border)
        SafetyRow(
            icon = Icons.Outlined.Block,
            text = stringResource(if (state.blocked) R.string.safety_unblock else R.string.safety_block),
            color = if (state.blocked) tokens.accentText else tokens.dangerText,
            enabled = !state.blockBusy,
            onClick = { actions.onToggleBlock(person) },
            tag = "person-block"
        )
    }
}

@Composable
private fun SafetyRow(icon: ImageVector, text: String, color: Color, enabled: Boolean, onClick: () -> Unit, tag: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = color)
    }
}
