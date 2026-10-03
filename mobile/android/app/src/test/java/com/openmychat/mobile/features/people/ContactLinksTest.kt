package com.openmychat.mobile.features.people

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ContactLinksTest {

    @Test
    fun phonesKeepOnlyDigitsAndTheLeadingPlus() {
        assertEquals("+77272447714", ContactLinks.phoneNumber("+7 (727) 244-77-14"))
        assertEquals("87012223344", ContactLinks.phoneNumber("8 701 222 33 44"))
    }

    @Test
    fun anythingThatIsNotAPhoneIsNotDialled() {
        assertNull(ContactLinks.phoneNumber("12"))
        assertNull(ContactLinks.phoneNumber("+7 701;ussd*#"))
        assertNull(ContactLinks.phoneNumber("позвоните секретарю"))
    }

    @Test
    fun emailsMustLookLikeAnAddressWithoutExtraParameters() {
        assertEquals("p.ivanov@cic.kz", ContactLinks.email(" p.ivanov@cic.kz "))
        assertNull(ContactLinks.email("a@b.kz?subject=x&body=y"))
        assertNull(ContactLinks.email("не адрес"))
        assertNull(ContactLinks.email("a@b"))
    }
}
