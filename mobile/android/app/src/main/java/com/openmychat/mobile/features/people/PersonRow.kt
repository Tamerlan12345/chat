package com.openmychat.mobile.features.people

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import com.openmychat.mobile.ui.components.textEdgeAfter
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.components.CentyAvatar
import com.openmychat.mobile.ui.components.SharedKeys
import com.openmychat.mobile.ui.components.sharedConversationElement
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme

/** Найденные части текста — accent-text, вес 600 (спецификация: подсветка во время поиска). */
fun highlighted(text: String, ranges: List<IntRange>, color: Color): AnnotatedString = buildAnnotatedString {
    append(text)
    ranges.forEach { range ->
        val start = range.first.coerceIn(0, text.length)
        val end = (range.last + 1).coerceIn(start, text.length)
        if (end > start) addStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold), start, end)
    }
}

/** Общие ключи переходов «строка → карточка → чат»: те же, что у личной переписки с человеком. */
fun personSharedKey(id: Long): String = SharedKeys.conversation(isChannel = false, id = id)

/**
 * Строка сотрудника, 64 dp: аватар 40 с точкой присутствия, имя (с подсветкой найденного),
 * «должность · отдел» в одну строку и «вн. 214» справа. Без шеврона (Android).
 */
@Composable
fun PersonRow(
    person: Person,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    highlights: List<IntRange> = emptyList(),
    /** Найденное в «должность · отдел» и во вн. номере (поиск не по имени). */
    subtitleHighlights: List<IntRange> = emptyList(),
    extensionHighlights: List<IntRange> = emptyList(),
    /** Отступ слева для вложенности в «Отделах». */
    indent: Dp = 0.dp,
    background: Color = CentyTheme.tokens.list,
    /** A hairline under the row from the text edge (polish pass, rule 1); not after a section's last row. */
    divider: Boolean = false
) {
    val tokens = CentyTheme.tokens
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill by animateColorAsState(if (pressed) tokens.primarySoft else Color.Transparent, CentyMotion.fast(), label = "person-press")
    val shared = personSharedKey(person.id)
    val largeText = LocalDensity.current.fontScale > 1.3f
    val extensionLabel = person.extension?.let { stringResource(R.string.people_extension, it) }
    // «вн. 214»: подсветка найденного сдвигается на длину префикса «вн. ».
    val extensionText = extensionLabel?.let { label ->
        val shift = label.length - person.extension!!.length
        highlighted(label, extensionHighlights.map { (it.first + shift)..(it.last + shift) }, tokens.accentText)
    }
    val hairline = tokens.border
    val textEdge = textEdgeAfter(PersonAvatar) + indent
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .background(fill)
            .drawBehind {
                if (divider) {
                    val y = size.height - 0.5.dp.toPx()
                    drawLine(hairline, Offset(textEdge.toPx(), y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                }
            }
            .clickable(interactionSource = interaction, indication = ripple(), role = Role.Button, onClick = onClick)
            .padding(start = 16.dp + indent, end = 16.dp, top = 8.dp, bottom = 8.dp)
            .testTag("person-${person.id}"),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CentyAvatar(
            name = person.fullName,
            avatarUrl = person.avatarUrl,
            status = person.status,
            size = PersonAvatar,
            ringColor = background,
            modifier = Modifier.sharedConversationElement(SharedKeys.avatar(shared))
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = highlighted(person.fullName, highlights, tokens.accentText),
                style = MaterialTheme.typography.titleMedium,
                color = tokens.textStrong,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.sharedConversationElement(SharedKeys.title(shared))
            )
            val subtitle = person.subtitle
            if (subtitle.isNotEmpty() || (largeText && person.extension != null)) {
                Text(
                    buildAnnotatedString {
                        append(highlighted(subtitle, subtitleHighlights, tokens.accentText))
                        // При крупном шрифте номер переезжает сюда и не сжимает имя.
                        if (largeText && extensionText != null) {
                            if (subtitle.isNotEmpty()) append(" · ")
                            append(extensionText)
                        }
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = tokens.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        if (!largeText && extensionText != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                extensionText,
                style = MaterialTheme.typography.labelSmall,
                color = tokens.textDim,
                maxLines = 1
            )
        }
    }
}

private val PersonAvatar = 40.dp
