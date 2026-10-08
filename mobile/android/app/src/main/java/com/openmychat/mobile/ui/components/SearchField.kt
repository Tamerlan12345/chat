package com.openmychat.mobile.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.R
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyRadius
import com.openmychat.mobile.ui.theme.CentyTheme

/**
 * Поле поиска в верхней панели («Чаты», «Сотрудники»): заливка bg-sunken без рамки (бриф,
 * полировка, п. 1), высота 48; рамка primary-line — только в режиме поиска, как у поля в фокусе.
 * В режиме поиска лупа сменяется стрелкой «Закрыть поиск»; крестик очищает строку. Return —
 * [onSearch] (открыть первый результат).
 */
@Composable
fun CentySearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    onActiveChange: (Boolean) -> Unit = {},
    onSearch: () -> Unit = {},
    focusRequester: FocusRequester? = null,
    /** Фокус поля пришёл или ушёл (экран сам решает, что считать режимом поиска). */
    onFocusChange: (Boolean) -> Unit = {},
    testTag: String = "search-field"
) {
    val tokens = CentyTheme.tokens
    val shape = RoundedCornerShape(CentyRadius.control)
    BasicTextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = tokens.textMain),
        cursorBrush = SolidColor(tokens.accentText),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        modifier = modifier
            .fillMaxWidth()
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .onFocusChanged {
                onFocusChange(it.isFocused)
                if (it.isFocused && !active) onActiveChange(true)
            }
            .testTag(testTag),
        decorationBox = { inner ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .background(tokens.sunken, shape)
                    .then(if (active) Modifier.border(1.dp, tokens.primaryLine, shape) else Modifier)
                    .padding(end = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                AnimatedContent(
                    targetState = active,
                    transitionSpec = { fadeIn(CentyMotion.fast()) togetherWith fadeOut(CentyMotion.fast()) },
                    label = "search-leading"
                ) { isActive ->
                    if (isActive) {
                        IconButton(onClick = { onActiveChange(false) }, modifier = Modifier.testTag("$testTag-close")) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.search_close),
                                tint = tokens.textSecondary
                            )
                        }
                    } else {
                        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Search, contentDescription = null, tint = tokens.textDim, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                    if (query.isEmpty()) {
                        Text(
                            placeholder,
                            style = MaterialTheme.typography.bodyLarge,
                            color = tokens.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    inner()
                }
                if (query.isNotEmpty()) {
                    IconButton(onClick = { onQueryChange("") }) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.inbox_search_clear), tint = tokens.textSecondary)
                    }
                } else {
                    Spacer(Modifier.width(8.dp))
                }
            }
        }
    )
}
