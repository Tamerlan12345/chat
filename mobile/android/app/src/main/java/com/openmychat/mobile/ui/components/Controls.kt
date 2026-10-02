package com.openmychat.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

/*
 * `primary` is a fill colour only. In dark mode it reaches 2.6:1 as text on elevated surfaces,
 * so every foreground use of the brand (text buttons, outlined buttons, focused fields, cursors,
 * progress) goes through these and uses `accentText` (#4a3dd2 light / #b0a9ff dark) instead.
 */

/** Material text button with accent-text content (dialog dismiss, inline actions). */
@Composable
fun CentyTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentColor: androidx.compose.ui.graphics.Color = CentyTheme.tokens.accentText,
    content: @Composable RowScope.() -> Unit
) {
    TextButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = contentColor),
        content = content
    )
}

/** Material outlined button with accent-text content and the strong hairline. */
@Composable
fun CentyOutlinedButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, content: @Composable RowScope.() -> Unit) {
    val tokens = CentyTheme.tokens
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        enabled = enabled,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(CentyRadius.control),
        border = BorderStroke(1.dp, tokens.borderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = tokens.accentText),
        content = content
    )
}

/** The one text-field colour set: card container, focused label, border and cursor in accent text. */
@Composable
fun centyFieldColors(): TextFieldColors {
    val tokens = CentyTheme.tokens
    return OutlinedTextFieldDefaults.colors(
        focusedBorderColor = tokens.accentText,
        focusedLabelColor = tokens.accentText,
        cursorColor = tokens.accentText,
        unfocusedBorderColor = androidx.compose.material3.MaterialTheme.colorScheme.outline,
        unfocusedContainerColor = tokens.card,
        focusedContainerColor = tokens.card,
        disabledContainerColor = tokens.card
    )
}
