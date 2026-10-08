package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/*
 * Кнопки всего приложения (спецификация «Buttons»):
 * - основная — одна на экран, заливка primary, белая подпись; нажатая — primary-pressed; выключенная —
 *   заливка 38 % и подпись text-dim; загрузка — индикатор на месте подписи, ширина не меняется;
 * - тональная (второстепенные действия) — primary-soft и accent-text, те же размеры;
 * - текстовая («Отмена», «Повторить», «Очистить поиск») — CentyTextButton из Controls.kt;
 * - опасная заливка danger-fill — только в диалоге подтверждения.
 * Высота 48 dp, радиус 12, подпись labelLarge 600. Нажатие — рябь и сжатие до 0.97.
 */

private val ButtonShape = RoundedCornerShape(12.dp)
private val ButtonPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)

enum class CentyButtonStyle { PRIMARY, TONAL, DANGER }

@Composable
fun CentyPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
    /** Что сообщить TalkBack, пока идёт загрузка (по умолчанию «Загрузка…»). */
    loadingDescription: String? = null
) = CentyButton(text, onClick, CentyButtonStyle.PRIMARY, modifier, enabled, loading, icon, loadingDescription)

@Composable
fun CentyTonalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null
) = CentyButton(text, onClick, CentyButtonStyle.TONAL, modifier, enabled, loading, icon)

/** Заливка danger-fill: только подтверждение необратимого действия в диалоге. */
@Composable
fun CentyDangerButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) = CentyButton(text, onClick, CentyButtonStyle.DANGER, modifier, enabled, loading = false, icon = null)

@Composable
fun CentyButton(
    text: String,
    onClick: () -> Unit,
    style: CentyButtonStyle,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
    loadingDescription: String? = null
) {
    val tokens = CentyTheme.tokens
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduce = LocalReduceMotion.current
    val scale by animateFloatAsState(
        targetValue = if (pressed && !reduce) 0.97f else 1f,
        animationSpec = CentyMotion.fast(),
        label = "button-press"
    )
    val (fill, pressedFill, label) = when (style) {
        CentyButtonStyle.PRIMARY -> Triple(tokens.primary, tokens.primaryPressed, Color.White)
        CentyButtonStyle.TONAL -> Triple(tokens.primarySoft, tokens.primaryLine, tokens.accentText)
        CentyButtonStyle.DANGER -> Triple(tokens.dangerFill, tokens.dangerFill, Color.White)
    }
    val loadingText = loadingDescription ?: androidx.compose.ui.res.stringResource(com.openmychat.mobile.R.string.loading)
    Button(
        onClick = onClick,
        // Во время загрузки кнопка не принимает нажатий, но выглядит включённой.
        enabled = enabled && !loading,
        shape = ButtonShape,
        contentPadding = ButtonPadding,
        interactionSource = interaction,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (pressed) pressedFill else fill,
            contentColor = label,
            disabledContainerColor = if (loading) fill else fill.copy(alpha = fill.alpha * 0.38f),
            disabledContentColor = if (loading) label else tokens.textDim
        ),
        elevation = null,
        modifier = modifier
            .heightIn(min = 48.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .semantics { if (loading) stateDescription = loadingText }
    ) {
        Box(contentAlignment = Alignment.Center) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                // Подпись остаётся в разметке и задаёт ширину, пока на её месте крутится индикатор.
                modifier = Modifier.alpha(if (loading) 0f else 1f)
            ) {
                if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Text(
                    text,
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                    textAlign = TextAlign.Center
                )
            }
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = label
                )
            }
        }
    }
}
