package com.openmychat.mobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion

/**
 * Lift-on-scroll (UI layer v2 depth model): a top bar is flat on its plane at rest and becomes an L3
 * surface (elevated tone + hairline) once content passes underneath, in 150 ms.
 */
@Composable
fun rememberLift(lifted: Boolean): State<Float> =
    animateFloatAsState(
        targetValue = if (lifted) 1f else 0f,
        animationSpec = CentyMotion.orReduced(LocalReduceMotion.current, CentyMotion.lift()),
        label = "lift"
    )

/** Paints the lifting bar behind its content; the progress is read in the draw phase only. */
@Composable
fun Modifier.liftSurface(progress: State<Float>, rest: Color): Modifier {
    val tokens = CentyTheme.tokens
    val lifted = tokens.elevated
    val hairline = tokens.border
    return drawBehind {
        val p = progress.value
        drawRect(lerp(rest, lifted, p))
        if (p > 0f) {
            val y = size.height - 0.5.dp.toPx()
            drawLine(hairline.copy(alpha = hairline.alpha * p), Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
        }
    }
}
