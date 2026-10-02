package com.openmychat.mobile.features.chat

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.openmychat.mobile.data.model.Message
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/** A flying text longer than this many lines (at the bubble's width) uses the bubble's fade instead. */
internal const val LANDING_MAX_LINES = 6

/**
 * The widest a bubble's text can be in this window: the same constraints as a bubble row (list
 * padding 12 + 12, the bubble box `widthIn(max = 320) fillMaxWidth(0.84)`, text padding 12 + 12),
 * so the travelling text wraps exactly as it will inside its bubble.
 */
internal fun bubbleTextMaxWidth(windowWidth: Dp): Dp = min(320.dp, (windowWidth - 24.dp) * 0.84f) - 24.dp

/**
 * "The message lands" (UI layer v2 focal moment). On send, the composer hands its text to a flight:
 * the text stays where it was typed until its own bubble arrives, then travels into that bubble's
 * text position in one continuous motion (240 ms, decelerate .16,1,.3,1) while its colour turns from
 * body text to the own-bubble accent. The bubble is revealed under it as it lands. Rapid sends queue
 * one flight each; the overlay is unclipped, above the composer and the list.
 */
@Stable
internal class LandingState {
    val flights = mutableStateListOf<Flight>()

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
        flights += Flight(text, start)
    }

    /** A fresh own bubble claims the oldest unclaimed flight with its text. */
    fun claim(key: String, message: Message): Boolean {
        if (flights.any { it.claimedKey == key }) return true
        val flight = flights.firstOrNull { it.claimedKey == null && it.text == message.text.trim() } ?: return false
        flight.claimedKey = key
        return true
    }

    /** True while [key]'s bubble should stay hidden under its travelling text. */
    fun hides(key: String): Boolean = flights.any { it.claimedKey == key && !it.landed }

    /** Follows the bubble while it settles (anchoring, the keyboard), until the text lands. */
    fun aim(key: String, target: Offset) {
        val flight = flights.firstOrNull { it.claimedKey == key } ?: return
        if (!flight.landed && flight.target != target) flight.target = target
    }

    internal fun clear(done: Flight) {
        flights.remove(done)
    }
}

@Composable
internal fun rememberLandingState(): LandingState = remember { LandingState() }

@Composable
internal fun LandingOverlay(state: LandingState) {
    if (state.flights.isEmpty()) return
    var origin by remember { mutableStateOf(Offset.Zero) }
    val textWidth = with(LocalDensity.current) { bubbleTextMaxWidth(LocalWindowInfo.current.containerSize.width.toDp()) }
    Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionInRoot() }) {
        state.flights.forEach { flight ->
            key(flight) { FlyingText(state, flight, origin, textWidth) }
        }
    }
}

@Composable
private fun FlyingText(state: LandingState, flight: LandingState.Flight, origin: Offset, textWidth: Dp) {
    val tokens = CentyTheme.tokens
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
    Text(
        flight.text,
        style = MaterialTheme.typography.bodyLarge,
        color = lerp(tokens.textMain, tokens.accentText, flight.progress.value),
        // The bubble's own text width: the travelling text wraps exactly like its bubble.
        modifier = Modifier
            .width(textWidth)
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
