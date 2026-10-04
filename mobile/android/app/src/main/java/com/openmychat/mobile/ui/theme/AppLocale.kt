package com.openmychat.mobile.ui.theme

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Интерфейс приложения всегда русский: в сборке только ресурсы по умолчанию (без values-xx).
 * Встроенные подписи Material (у нижнего листа: «Close sheet», «Drag handle») берутся из ресурсов
 * библиотеки по языку системы, поэтому на устройстве с другим языком они были бы английскими.
 * Activity оборачивается конфигурацией, в которой переопределён только язык (как это делает
 * AppCompat); так русские подписи получают и компоненты Material в отдельном окне (лист, диалоги).
 *
 * Важно: переопределение содержит ТОЛЬКО язык. Activity не пересоздаётся при повороте и смене
 * размера (configChanges в манифесте), поэтому любое другое поле, зафиксированное здесь
 * (ориентация, ширина, масштаб шрифта, тёмная тема), осталось бы устаревшим.
 */
object AppLocale {
    private val RU = Locale.forLanguageTag("ru")

    fun wrap(base: Context): Context = base.createConfigurationContext(languageOnlyOverride())

    internal fun languageOnlyOverride(): Configuration = Configuration().apply {
        // Configuration() стартует с fontScale = 1; 0 означает «не переопределять».
        fontScale = 0f
        setLocale(RU)
    }
}
