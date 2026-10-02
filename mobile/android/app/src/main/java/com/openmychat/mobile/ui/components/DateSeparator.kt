package com.openmychat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyTheme
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Day separator: an L3 pill (elevated tone and a hairline). Inline in the history and, as the
 * sticky copy, floating at the top of the chat while that day scrolls by.
 */
@Composable
fun DateSeparator(label: String, modifier: Modifier = Modifier) {
    val tokens = CentyTheme.tokens
    Text(
        text = label,
        style = MaterialTheme.typography.labelMedium,
        color = tokens.textSecondary,
        modifier = modifier
            .background(tokens.elevated, CircleShape)
            .border(1.dp, tokens.border, CircleShape)
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .semantics { heading() }
    )
}

/** «Сегодня», «Вчера», «2 октября», «2 октября 2025». */
@Composable
fun dayLabel(date: LocalDate, today: LocalDate = LocalDate.now()): String =
    dayLabel(date, today, stringResource(R.string.chat_today), stringResource(R.string.chat_yesterday))

fun dayLabel(date: LocalDate, today: LocalDate, todayLabel: String, yesterdayLabel: String): String = when (date) {
    today -> todayLabel
    today.minusDays(1) -> yesterdayLabel
    else -> date.format(if (date.year == today.year) DayFormat else DayYearFormat)
}

private val RussianLocale = Locale.forLanguageTag("ru")
private val DayFormat = DateTimeFormatter.ofPattern("d MMMM", RussianLocale)
private val DayYearFormat = DateTimeFormatter.ofPattern("d MMMM yyyy", RussianLocale)
