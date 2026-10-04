package com.openmychat.mobile.ui.theme

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Интерфейс приложения всегда русский: в сборке только ресурсы по умолчанию (без values-xx).
 * Встроенные подписи Material (у нижнего листа: «Close sheet», «Drag handle») берутся из ресурсов
 * библиотеки по языку системы, поэтому на устройстве с другим языком они были бы английскими.
 * Activity оборачивается русской конфигурацией ресурсов (как это делает AppCompat); так русские
 * подписи получают и компоненты Material, живущие в отдельном окне (лист, диалоги), и любые
 * другие компоненты Material, которые появятся позже.
 */
object AppLocale {
    private val RU = Locale.forLanguageTag("ru")

    fun wrap(base: Context): Context {
        val config = Configuration(base.resources.configuration).apply { setLocale(RU) }
        return base.createConfigurationContext(config)
    }
}
