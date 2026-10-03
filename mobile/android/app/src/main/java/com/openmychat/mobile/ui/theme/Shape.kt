package com.openmychat.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** The desktop radius family: 6 chips, 8 bubbles/fields/buttons, 12 cards and sheets, 16 large surfaces. */
val Shapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(16.dp)
)

object CentyRadius {
    val chip = 6.dp
    val control = 8.dp
    val card = 12.dp
    val surface = 16.dp

    /** The bubble corner nearest the sender: the desktop signature tail. */
    val tail = 2.dp

    /** Where two bubbles of one group meet (sender side): as tight as the tail, so a group reads as one edge. */
    val joined = 2.dp
}
