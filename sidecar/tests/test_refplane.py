"""Pure-logic tests for sw_agent.refplane and bridge.try_member — no SolidWorks, no COM.

Locks down what CAN be checked without a machine: the constraint bit-flag table, the
"did the plane land where we asked" decision, and — new in P120 — the member re-binding
ladder that four rounds of this bug turned on.
"""
import unittest

from sw_agent import refplane
from sw_agent.bridge import SWError, try_member


class TestConstraintTable(unittest.TestCase):
    def test_all_powers_of_two_and_distinct(self):
        values = list(refplane.CONSTRAINT.values())
        self.assertEqual(len(values), len(set(values)), "duplicate constraint values")
        for name, v in refplane.CONSTRAINT.items():
            self.assertTrue(v > 0 and v & (v - 1) == 0, f"{name}={v} is not a single bit")

    def test_documented_values(self):
        """Distance=8 (in use since P13), Flip=256 (the value P105 should have used)."""
        self.assertEqual(refplane.CONSTRAINT["distance"], 8)
        self.assertEqual(refplane.CONSTRAINT["flip"], 256)

    def test_distance_plus_flip_is_264(self):
        mask = refplane.CONSTRAINT["distance"] | refplane.CONSTRAINT["flip"]
        self.assertEqual(mask, 264)
        self.assertNotEqual(mask, 15, "P105's mask")
        self.assertNotEqual(mask, 16, "P114's SelectOption")

    def test_constraint_mask_rejects_unknown(self):
        self.assertEqual(refplane.constraint_mask("distance"), 8)
        with self.assertRaises(SWError):
            refplane.constraint_mask("nope")


class TestWrongSide(unittest.TestCase):
    def test_correct_position(self):
        self.assertFalse(refplane.wrong_side(-0.05, -0.05, 2e-6))

    def test_opposite_sign(self):
        """The bug itself: -50 mm asked for, plane built at +50 mm."""
        self.assertTrue(refplane.wrong_side(0.05, -0.05, 5e-5))

    def test_wrong_magnitude(self):
        self.assertTrue(refplane.wrong_side(0.005, 0.05, 5e-5))

    def test_within_tolerance(self):
        self.assertFalse(refplane.wrong_side(0.0500004, 0.05, 5e-5))


class TestAxisMapping(unittest.TestCase):
    def test_y_up_convention(self):
        """SolidWorks is Y-up: Front normal=Z(2), Top normal=Y(1), Right normal=X(0)."""
        self.assertEqual(refplane.NORMAL_AXIS, {"front": 2, "top": 1, "right": 0})


class _MemberNotFound(Exception):
    """Stands in for com_error(-2147352573, '找不到成员') — the error every route hit."""


class _Bound:
    """An object bound to one interface: `ok` resolves, `hidden` does not — exactly the
    early-binding shape that made GetSpecificFeature2 'not exist' on a real IFeature."""

    def __init__(self):
        self._oleobj_ = "raw-idispatch-handle"

    def __getattr__(self, name):
        if name == "ok":
            return "direct-value"
        raise _MemberNotFound(name)


class TestTryMember(unittest.TestCase):
    def test_reachable_member_reads_directly(self):
        val, note = try_member(_Bound(), "ok", "IFeature")
        self.assertEqual(val, "direct-value")
        self.assertEqual(note, "direct")

    def test_unreachable_member_reports_why(self):
        """No CastTo module and no usable IDispatch in this sandbox, so the read must
        fail — but it must fail with the reason attached, not silently. Silence is what
        cost P116 and P118 two real-machine rounds."""
        val, note = try_member(_Bound(), "hidden", "IFeature")
        self.assertIsNone(val)
        self.assertIn("direct:", note)
        self.assertTrue(len(note) > len("direct:"), "note carries no diagnosis")

    def test_never_raises(self):
        for target in (_Bound(), object(), None):
            val, note = try_member(target, "whatever", "IFeature")
            self.assertIsNone(val)
            self.assertIsInstance(note, str)


if __name__ == "__main__":
    unittest.main()
