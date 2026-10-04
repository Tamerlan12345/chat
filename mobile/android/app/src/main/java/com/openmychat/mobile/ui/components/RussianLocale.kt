package com.openmychat.mobile.ui.components

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

/**
 * Интерфейс приложения всегда русский, а встроенные подписи Material (например, «Close sheet» и
 * «Drag handle» у нижнего листа) берутся из языка системы. Внутри этого блока они русские.
 */
@Composable
fun RussianLocale(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val russian = remember(context, configuration) {
        val config = Configuration(configuration).apply { setLocale(Locale("ru")) }
        config to context.createConfigurationContext(config)
    }
    CompositionLocalProvider(LocalConfiguration provides russian.first, LocalContext provides russian.second, content = content)
}
