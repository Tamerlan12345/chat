package com.openmychat.mobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

private fun style(
    size: TextUnit,
    line: TextUnit,
    weight: FontWeight = FontWeight.Normal,
    tracking: TextUnit = 0.sp,
    tabular: Boolean = false
) = TextStyle(
    fontFamily = FontFamily.Default, // Roboto, the system face
    fontWeight = weight,
    fontSize = size,
    lineHeight = line,
    letterSpacing = tracking,
    fontFeatureSettings = if (tabular) "tnum" else null
)

/**
 * The full Material type scale in sp, so text follows the system font size. Tracking is tighter
 * than Material's defaults, like the desktop's Segoe UI. Labels use tabular digits for times and
 * counters. Brief mapping: row name titleMedium, preview bodyMedium, time labelSmall, bubble
 * bodyLarge, screen title titleLarge.
 */
val Typography = Typography(
    displayLarge = style(57.sp, 64.sp, tracking = (-0.02).em),
    displayMedium = style(45.sp, 52.sp, tracking = (-0.02).em),
    displaySmall = style(36.sp, 44.sp, tracking = (-0.02).em),
    headlineLarge = style(32.sp, 40.sp, FontWeight.SemiBold, (-0.02).em),
    headlineMedium = style(28.sp, 36.sp, FontWeight.SemiBold, (-0.02).em),
    headlineSmall = style(24.sp, 32.sp, FontWeight.SemiBold, (-0.01).em),
    titleLarge = style(22.sp, 28.sp, FontWeight.SemiBold, (-0.01).em),
    titleMedium = style(16.sp, 22.sp, FontWeight.SemiBold),
    titleSmall = style(14.sp, 20.sp, FontWeight.Medium),
    bodyLarge = style(16.sp, 23.sp, tracking = 0.1.sp),
    bodyMedium = style(14.sp, 20.sp, tracking = 0.1.sp),
    bodySmall = style(12.sp, 16.sp, tracking = 0.2.sp),
    labelLarge = style(14.sp, 20.sp, FontWeight.Medium, 0.1.sp),
    labelMedium = style(12.sp, 16.sp, FontWeight.Medium, 0.2.sp, tabular = true),
    labelSmall = style(11.sp, 16.sp, FontWeight.Medium, 0.3.sp, tabular = true)
)
