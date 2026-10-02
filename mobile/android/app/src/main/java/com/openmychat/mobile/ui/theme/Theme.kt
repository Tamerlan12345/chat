package com.openmychat.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

/**
 * Material roles derived from [CentyTokens]. Container roles are the brief's translucent tokens
 * flattened onto the canvas so Material components that need an opaque colour get one.
 * Dynamic colour is deliberately off: the brand is pinned to the desktop.
 */
internal val LightColorScheme: ColorScheme = LightCentyTokens.let { t ->
    lightColorScheme(
        primary = t.primary,
        onPrimary = Color.White,
        primaryContainer = Color(0xFFECEBFB), // primary-soft on canvas
        onPrimaryContainer = Color(0xFF17133D), // on-selected
        inversePrimary = Color(0xFFB0A9FF),
        secondary = t.textSecondary,
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFECEBFB),
        onSecondaryContainer = t.accentText,
        tertiary = Color(0xFF2A72EE), // brand azure
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFFDDE7FF),
        onTertiaryContainer = Color(0xFF001B3F),
        error = t.danger,
        onError = Color.White,
        errorContainer = Color(0xFFF9ECEE), // danger-soft on canvas
        onErrorContainer = t.dangerText,
        background = t.canvas,
        onBackground = t.textStrong,
        surface = t.list,
        onSurface = t.textStrong,
        surfaceVariant = t.frame,
        onSurfaceVariant = t.textSecondary,
        surfaceTint = t.list, // no tonal tint: elevation is tone + hairline
        inverseSurface = Color(0xFF2B2B32),
        inverseOnSurface = Color(0xFFF4F4F7),
        outline = Color(0xFF8A8A96), // input baseline, >= 3:1 on card
        outlineVariant = Color(0xFFE3E3E9), // border on canvas
        scrim = Color(0xFF141428),
        surfaceBright = t.canvas,
        surfaceDim = t.frame,
        surfaceContainerLowest = t.card,
        surfaceContainerLow = Color(0xFFF7F7FA), // bg-panel
        surfaceContainer = t.list,
        surfaceContainerHigh = t.elevated,
        surfaceContainerHighest = t.frame
    )
}

internal val DarkColorScheme: ColorScheme = DarkCentyTokens.let { t ->
    darkColorScheme(
        // The brief's #6457ee with white text for filled buttons; #b0a9ff stays accent text only.
        primary = t.primary,
        onPrimary = Color.White,
        primaryContainer = Color(0xFF36354C), // primary-soft on canvas
        onPrimaryContainer = Color.White,
        inversePrimary = Color(0xFF5B4EE6),
        secondary = t.textSecondary,
        onSecondary = t.list,
        secondaryContainer = Color(0xFF36354C),
        onSecondaryContainer = t.accentText,
        tertiary = Color(0xFF8FB4FF),
        onTertiary = Color(0xFF002F6D),
        tertiaryContainer = Color(0xFF084DAD),
        onTertiaryContainer = Color(0xFFDDE7FF),
        error = t.danger,
        onError = Color.White,
        errorContainer = Color(0xFF3F292F), // danger-soft on canvas
        onErrorContainer = t.dangerText,
        background = t.canvas,
        onBackground = t.textStrong,
        surface = t.list,
        onSurface = t.textStrong,
        surfaceVariant = t.card,
        onSurfaceVariant = t.textSecondary,
        surfaceTint = t.list,
        inverseSurface = Color(0xFFE6E6EC),
        inverseOnSurface = t.list,
        outline = Color(0xFF80808C),
        outlineVariant = Color(0xFF36363D),
        scrim = Color(0xFF08080C),
        surfaceBright = t.elevated,
        surfaceDim = t.frame,
        surfaceContainerLowest = t.frame,
        surfaceContainerLow = t.list,
        surfaceContainer = t.canvas,
        surfaceContainerHigh = t.elevated,
        surfaceContainerHighest = Color(0xFF34343C)
    )
}

@Composable
fun CentyChatTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /** Null follows the system "Remove animations" setting; tests may force it. */
    reduceMotion: Boolean? = null,
    content: @Composable () -> Unit
) {
    val systemReduceMotion = rememberSystemReduceMotion()
    val tokens = if (darkTheme) DarkCentyTokens else LightCentyTokens
    CompositionLocalProvider(
        LocalCentyTokens provides tokens,
        LocalReduceMotion provides (reduceMotion ?: systemReduceMotion),
        // Selection handles and highlight in accent text, not the fill-only primary.
        LocalTextSelectionColors provides TextSelectionColors(tokens.accentText, tokens.accentText.copy(alpha = 0.3f))
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
            typography = Typography,
            shapes = Shapes,
            content = content
        )
    }
}
