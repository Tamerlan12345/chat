package com.openmychat.mobile.ui.theme

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
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
 * The motion grammar from the brief, taken from desktop `theme.css`:
 * ease-out `cubic-bezier(.22,1,.36,1)`, fast 120 ms, base 180 ms, slow 280 ms.
 * Exits are faster than entrances. Every spatial effect has a crossfade-or-instant fallback when
 * the system "Remove animations" setting is on ([LocalReduceMotion]).
 */
object CentyMotion {
    val EaseOut = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
    val EasePress = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    const val FAST = 120
    const val BASE = 180
    const val SLOW = 280

    /** Own message lifting out of the composer. */
    const val SEND = 220

    /** Incoming message fade + rise (desktop `message-in` 0.26 s). */
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

    /** [spec] normally; a 120 ms crossfade-length tween (or a snap) when motion is reduced. */
    fun <T> orReduced(reduce: Boolean, spec: FiniteAnimationSpec<T>, instant: Boolean = false): FiniteAnimationSpec<T> =
        when {
            !reduce -> spec
            instant -> snap()
            else -> tween(FAST)
        }
}

/** True when the system asks for no animation (Developer options / Accessibility "Remove animations"). */
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
