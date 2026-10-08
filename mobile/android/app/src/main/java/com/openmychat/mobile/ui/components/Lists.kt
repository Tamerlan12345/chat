package com.openmychat.mobile.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentySpace
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Lists of the polish pass: borderless rows on their plane, separated by a hairline that starts at
 * the text edge (rule 1), and native Android sections headed in `titleSmall` (rule 8) with 24 above
 * and 8 below (rule 2).
 */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, first: Boolean = false) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = CentyTheme.tokens.accentText,
        modifier = modifier
            .fillMaxWidth()
            .padding(
                start = CentySpace.gutter,
                end = CentySpace.gutter,
                top = if (first) CentySpace.s else CentySpace.section,
                bottom = CentySpace.headerBelow
            )
            .semantics { heading() }
    )
}

/** A hairline between rows that starts where the row's text starts. */
@Composable
fun InsetDivider(start: Dp, modifier: Modifier = Modifier) {
    HorizontalDivider(modifier.padding(start = start), thickness = 1.dp, color = CentyTheme.tokens.border)
}

/** Text edge of a row with a [avatar]-sized leading element: gutter + avatar + the 12 dp gap. */
fun textEdgeAfter(avatar: Dp): Dp = CentySpace.gutter + avatar + CentySpace.rowGap
