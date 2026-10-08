package com.openmychat.mobile.ui.theme

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * The motion grammar, taken from desktop `theme.css`: ease-out `cubic-bezier(.22,1,.36,1)`, fast
 * 120 ms, base 180 ms, slow 280 ms; the UI layer v2 decelerate [EaseOutExpo] for arrivals. Exits are
 * faster than entrances. Every spatial effect has a crossfade-or-instant fallback when the system
 * "Remove animations" setting is on ([LocalReduceMotion]).
 *
 * What the app does today (kept in step with the code, not with the brief's first draft):
 *
 * | Effect | Motion | Reduce motion |
 * |---|---|---|
 * | Own message, text fits 6 lines | the composer text travels into its bubble ([SEND], expo); the bubble is revealed under it as it lands (`ChatLanding`) | no flight: 120 ms fade |
 * | Own message without a flight (too long, sent elsewhere) | fade + 8 dp rise ([INCOMING], ease-out) — the same as an incoming one | 120 ms fade |
 * | Incoming message | fade + 8 dp rise ([INCOMING]) | 120 ms fade |
 * | Rows making room | `animateItem` placement [SEND], expo; removed rows fade out [FAST] | no placement motion |
 * | Delivery glyph | each state strokes in [GLYPH_DRAW]; on a landed bubble after 0.6 × [SEND] | instant swap |
 * | Failed glyph | one 4 dp shake [SHAKE] + warning haptic | colour only, haptic stays |
 * | Inbox ↔ chat, row ↔ card | shared avatar and name [SHARED]; the rest fades through (out [FADE_THROUGH_OUT], in after it) | [REDUCED_CROSSFADE] crossfade |
 * | Other navigation | shared-axis X, [SLOW] slide by 1/12 width + fade | [REDUCED_CROSSFADE] crossfade |
 * | Tab switch | 150 ms crossfade, no slide | same |
 * | Bottom bar on inbox ↔ chat | the scaffold's one slide, started in the same frame as the navigation (`rememberBottomBarState`) | cut |
 * | Top bar lift on scroll | tone + hairline, [LIFT] | 120 ms |
 * | Composer height | grows at once, shrinks with [grow] (spring 0.85) | steps |
 * | Attach ↔ send | scale 0.7 ↔ 1 + crossfade, [LIFT] | 120 ms crossfade |
 * | Connection banner | expands [SLOW]; «Снова в сети» holds [BACK_ONLINE] | fade |
 * | «Ознакомлен» | check draws in [STAMP] | drawn |
 * | Typing dots | [TYPING_CYCLE] wave, [TYPING_STAGGER] stagger, only while typing | still |
 * | Skeleton | [SHIMMER] sweep | still |
 */
object CentyMotion {
    val EaseOut = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
    val EasePress = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    const val FAST = 120
    const val BASE = 180
    const val SLOW = 280

    /**
     * UI layer v2 decelerate for confident arrivals, `cubic-bezier(.16,1,.3,1)`: the message lands,
     * shared elements settle.
     */
    val EaseOutExpo = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

    /**
     * "The message lands": the composer text travelling into its own bubble. Also the placement of
     * rows making room for it.
     */
    const val SEND = 240

    /** Delivery glyph: each state draws its stroke in this time. */
    const val GLYPH_DRAW = 160

    /** Failed glyph: one 4dp shake. */
    const val SHAKE = 280

    /** Top bar lift on scroll, attach → send morph. */
    const val LIFT = 150

    /** Inbox → chat: shared avatar and name, fade-through for the rest. */
    const val SHARED = 300
    const val FADE_THROUGH_OUT = 90

    /** Reduce motion: shared elements and the navigation become a crossfade of this length. */
    const val REDUCED_CROSSFADE = 150

    /** «Снова в сети» stays this long, then the banner collapses. */
    const val BACK_ONLINE = 1_200

    /** «Ознакомлен» stamp: the check draws in. */
    const val STAMP = 280

    /**
     * Fade + 8 dp rise of a fresh bubble without a flight: incoming, own from another device, or own
     * text too long to travel (desktop `message-in` 0.26 s).
     */
    const val INCOMING = 260

    /** Skeleton shimmer sweep. */
    const val SHIMMER = 1_200

    /** Typing dots cycle and per-dot stagger (desktop `typing-blink`). */
    const val TYPING_CYCLE = 1_200
    const val TYPING_STAGGER = 200

    /** Incoming call breathing ring, one way. */
    const val BREATH = 1_600

    fun <T> fast(): FiniteAnimationSpec<T> = tween(FAST, easing = EaseOut)
    fun <T> base(): FiniteAnimationSpec<T> = tween(BASE, easing = EaseOut)
    fun <T> slow(): FiniteAnimationSpec<T> = tween(SLOW, easing = EaseOut)
    fun <T> land(): FiniteAnimationSpec<T> = tween(SEND, easing = EaseOutExpo)
    fun <T> lift(): FiniteAnimationSpec<T> = tween(LIFT, easing = EaseOut)

    /** Composer height while it grows line by line (damping 0.85, no overshoot to speak of). */
    fun <T> grow(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMediumLow)

    /** [spec] normally; a 120 ms crossfade-length tween (or a snap) when motion is reduced. */
    fun <T> orReduced(reduce: Boolean, spec: FiniteAnimationSpec<T>, instant: Boolean = false): FiniteAnimationSpec<T> =
        when {
            !reduce -> spec
            instant -> snap()
            else -> tween(FAST)
        }
}

/**
 * True when the system asks for no animation: Accessibility «Удалить анимацию» / Developer options,
 * i.e. `ANIMATOR_DURATION_SCALE == 0`.
 *
 * Why every reduce branch ends in a cut on Android: Compose multiplies every animation duration by
 * that same system scale, so at 0 even the brief's 150 ms reduce-motion crossfade lasts 0 ms. That
 * is the platform's contract and is kept. The reduce branches still matter: they remove spatial
 * motion (no lift, no shared elements, no landing flight, no shake, no placement slides) and pick
 * fades or instant swaps, so nothing moves even for the one frame a cut shows. A scale between 0
 * and 1 is honoured by the system as shorter animations, with the full motion.
 */
val LocalReduceMotion = compositionLocalOf { false }

/** Reads `ANIMATOR_DURATION_SCALE` and follows changes while the app is open. */
@Composable
internal fun rememberSystemReduceMotion(): Boolean {
    val context = LocalContext.current
    val resolver = context.contentResolver
    fun read(): Boolean = try {
        Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (_: Exception) {
        false
    }
    var reduce by remember(resolver) { mutableStateOf(read()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduce = read()
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        try {
            resolver.registerContentObserver(uri, false, observer)
        } catch (_: Exception) {
        }
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return reduce
}
