package com.openmychat.mobile.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.openmychat.mobile.BuildConfig
import com.openmychat.mobile.R
import com.openmychat.mobile.core.network.AvatarOptIn
import com.openmychat.mobile.data.model.UserStatus
import com.openmychat.mobile.ui.theme.CentyMotion
import com.openmychat.mobile.ui.theme.CentyTheme
import com.openmychat.mobile.ui.theme.LocalReduceMotion
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * One avatar for the whole app, like desktop `Avatar.jsx`: the photo when it loads, otherwise
 * initials on a colour that is constant for the person on every client. Channels use slate.
 * Decorative for accessibility: the row or title next to it names the person.
 */
@Composable
fun CentyAvatar(
    name: String,
    modifier: Modifier = Modifier,
    avatarUrl: String? = null,
    status: UserStatus? = null,
    size: Dp = 44.dp,
    isChannel: Boolean = false,
    /** Colour behind the avatar; the presence dot is cut out of it. */
    ringColor: Color = CentyTheme.tokens.list,
    /** The person is typing: the presence dot pulses softly (still with reduce motion). */
    typing: Boolean = false
) {
    val tokens = CentyTheme.tokens
    val source = remember(avatarUrl, size) {
        AvatarPalette.resolveUrl(avatarUrl, BuildConfig.SERVER_URL, AvatarOptIn.sizeFor(size.value))
    }
    var failed by remember(source) { mutableStateOf(false) }
    val shape = if (isChannel) RoundedCornerShape(size * 0.3f) else CircleShape

    Box(modifier = modifier.size(size).clearAndSetSemantics { }) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clip(shape)
                .background(if (isChannel) tokens.channelAvatar else AvatarPalette.colorFor(name)),
            contentAlignment = Alignment.Center
        ) {
            val fontSize = with(LocalDensity.current) { (size * 0.38f).toSp() }
            Text(
                text = if (isChannel) "#" else AvatarPalette.initialsOf(name),
                color = Color.White,
                style = TextStyle(fontSize = fontSize, fontWeight = FontWeight.SemiBold)
            )
            if (source != null && !failed) {
                AsyncImage(
                    model = source,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    onError = { failed = true },
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
        if (status != null && !isChannel) {
            StatusDot(
                status = status,
                size = (size * 0.3f).coerceAtLeast(10.dp),
                ringColor = ringColor,
                pulse = typing,
                modifier = Modifier.align(Alignment.BottomEnd)
            )
        }
    }
}

/** Presence colour as a small dot only (never a fill or text). Colour changes fade like desktop. */
@Composable
fun StatusDot(
    status: UserStatus,
    modifier: Modifier = Modifier,
    size: Dp = 10.dp,
    ringColor: Color? = null,
    pulse: Boolean = false
) {
    val target = presenceColor(status)
    val color by animateColorAsState(
        targetValue = target,
        animationSpec = CentyMotion.orReduced(LocalReduceMotion.current, CentyMotion.slow(), instant = true),
        label = "presence"
    )
    // The pulse runs only while typing (a typing indicator, like the dots) and is read in the layer.
    val beat: State<Float>? = if (pulse && !LocalReduceMotion.current) {
        rememberInfiniteTransition(label = "presence-pulse").animateFloat(
            initialValue = 1f,
            targetValue = 1.22f,
            animationSpec = infiniteRepeatable(tween(CentyMotion.TYPING_CYCLE / 2, easing = CentyMotion.EaseOut), RepeatMode.Reverse),
            label = "presence-beat"
        )
    } else null
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer {
                val s = beat?.value ?: 1f
                scaleX = s
                scaleY = s
            }
            .then(if (ringColor != null) Modifier.background(ringColor, CircleShape).padding(size * 0.16f) else Modifier)
            .background(color, CircleShape)
    )
}

@Composable
fun presenceColor(status: UserStatus): Color {
    val tokens = CentyTheme.tokens
    return when (status) {
        UserStatus.ONLINE -> tokens.online
        UserStatus.AWAY -> tokens.away
        UserStatus.DND -> tokens.dnd
        UserStatus.OFFLINE -> tokens.offline
    }
}

@Composable
fun presenceLabel(status: UserStatus): String = stringResource(
    when (status) {
        UserStatus.ONLINE -> R.string.status_online
        UserStatus.AWAY -> R.string.status_away
        UserStatus.DND -> R.string.status_dnd
        UserStatus.OFFLINE -> R.string.status_offline
    }
)

/** Desktop `lib/avatar.mjs`, ported exactly so a person has the same colour on every client. */
object AvatarPalette {
    /** White initials on each of these read at 4.5:1 or better. */
    val colors = listOf(
        Color(0xFF2563EB), Color(0xFF7C3AED), Color(0xFF0E7490), Color(0xFF047857),
        Color(0xFFB45309), Color(0xFFBE185D), Color(0xFF4338CA), Color(0xFF475569)
    )

    fun colorIndex(name: String): Int {
        var hash = 0u
        name.forEach { hash = hash * 31u + it.code.toUInt() }
        hash = hash xor (hash shr 16)
        hash *= 0x45d9f3bu
        hash = hash xor (hash shr 16)
        return (hash % colors.size.toUInt()).toInt()
    }

    fun colorFor(name: String): Color = colors[colorIndex(name)]

    /** «Фамилия Имя» → «ФИ»; a lowercase second word («Администратор системы») is not a name. */
    fun initialsOf(name: String): String {
        val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return "?"
        val second = words.getOrNull(1)?.takeIf { it.first().isUpperCase() }?.first()?.toString().orEmpty()
        return (words[0].first().toString() + second).uppercase()
    }

    /**
     * Only HTTPS images, absolute or relative to the fixed server. Anything else (plain HTTP,
     * data:, file:, garbage) falls back to initials.
     */
    fun resolveUrl(raw: String?, serverUrl: String, size: AvatarOptIn.Size? = null): String? {
        val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val url = if (value.startsWith("/")) {
            serverUrl.toHttpUrlOrNull()?.resolve(value)
        } else {
            value.toHttpUrlOrNull()
        } ?: return null
        if (!url.isHttps) return null
        // Аватары своего сервера — нужного размера (96 или 256 px), а не всегда крупные.
        return (if (size != null) AvatarOptIn.sized(url, size) else url).toString()
    }
}
