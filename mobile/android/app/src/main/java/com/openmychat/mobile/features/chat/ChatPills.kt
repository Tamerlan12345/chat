package com.openmychat.mobile.features.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.components.DateSeparator
import com.openmychat.mobile.ui.components.dayLabel
import com.openmychat.mobile.ui.theme.CentyMotion
import java.time.LocalDate

/** The day separator inside the history. */
@Composable
internal fun DaySeparatorRow(date: LocalDate, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
        DateSeparator(dayLabel(date))
    }
}

/**
 * The sticky copy of the day separator: it floats at the top of the history while that day's
 * messages pass under it, and hands over to the inline separator when it reaches the top.
 */
@Composable
internal fun StickyDatePill(day: LocalDate?, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf(day) }
    if (day != null) shown = day
    AnimatedVisibility(
        visible = day != null,
        modifier = modifier,
        enter = fadeIn(CentyMotion.fast()),
        exit = fadeOut(CentyMotion.fast())
    ) {
        shown?.let { DateSeparator(dayLabel(it), Modifier.testTag("sticky-date")) }
    }
}
