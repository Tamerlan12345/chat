package com.openmychat.mobile.features.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.lerp
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * "The message lands" (UI layer v2 focal moment). On send, the composer hands its text to a flight:
 * the text stays where it was typed until its own bubble arrives, then travels into that bubble's
 * text position in one continuous motion (240 ms, decelerate .16,1,.3,1) while its colour turns from
 * body text to the own-bubble accent. The bubble is revealed under it as it lands. The overlay is
 * unclipped, above the composer and the list.
 */
@Stable
internal class LandingState {
    var flight by mutableStateOf<Flight?>(null)
        private set

    class Flight(val text: String, val start: Offset) {
        /** The bubble that carries this text, once it is in the list. */
        var claimedKey by mutableStateOf<String?>(null)

        /** Where that bubble's text starts, in root coordinates. */
        var target by mutableStateOf<Offset?>(null)
        var landed by mutableStateOf(false)
        val progress = Animatable(0f)
        val alpha = Animatable(1f)
    }

    fun launch(text: String, start: Offset) {
        flight = Flight(text, start)
    }

    /** A fresh own bubble asks whether it is the one in flight; the first match claims it. */
    fun claim(key: String, message: Message): Boolean {
        val current = flight ?: return false
        if (current.claimedKey != null) return current.claimedKey == key
        if (message.text.trim() != current.text) return false
        current.claimedKey = key
        return true
    }

    /** True while [key]'s bubble should stay hidden under the travelling text. */
    fun hides(key: String): Boolean = flight?.let { it.claimedKey == key && !it.landed } == true

    /** Follows the bubble while it settles (anchoring, the keyboard), until the text lands. */
    fun aim(key: String, target: Offset) {
        val current = flight ?: return
        if (current.claimedKey == key && !current.landed && current.target != target) current.target = target
    }

    internal fun clear(done: Flight) {
        if (flight === done) flight = null
    }
}

@Composable
internal fun rememberLandingState(): LandingState = remember { LandingState() }

@Composable
internal fun LandingOverlay(state: LandingState) {
    val flight = state.flight ?: return
    val tokens = CentyTheme.tokens
    var origin by remember { mutableStateOf(Offset.Zero) }
    LaunchedEffect(flight) {
        // No bubble came back (the send is still on its way): the text fades where it was.
        delay(900)
        if (flight.target == null) {
            flight.alpha.animateTo(0f, tween(CentyMotion.BASE))
            state.clear(flight)
        }
    }
    val aimed = flight.target != null
    LaunchedEffect(flight, aimed) {
        if (!aimed) return@LaunchedEffect
        flight.progress.animateTo(1f, tween(CentyMotion.SEND, easing = CentyMotion.EaseOutExpo))
        flight.landed = true
        // One frame with both, then the bubble alone.
        delay(32)
        state.clear(flight)
    }
    val from = tokens.textMain
    val to = tokens.accentText
    Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionInRoot() }) {
        Text(
            flight.text,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 6,
            overflow = TextOverflow.Ellipsis,
            color = lerp(from, to, flight.progress.value),
            modifier = Modifier
                .widthIn(max = 296.dp)
                .testTag("landing-text")
                .offset {
                    val p = flight.progress.value
                    val end = flight.target ?: flight.start
                    val at = lerp(flight.start, end, p) - origin
                    IntOffset(at.x.roundToInt(), at.y.roundToInt())
                }
                .graphicsLayer { alpha = flight.alpha.value }
        )
    }
}
