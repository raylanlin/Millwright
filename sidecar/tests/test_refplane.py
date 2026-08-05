"""Pure-logic tests for sw_agent.refplane — no SolidWorks, no COM.

Locks down what CAN be checked without a machine: the constraint table is a real set of
bit flags with the documented values, and the "did the plane land where we asked" decision
is sign-aware.
"""
import unittest

from sw_agent import refplane
from sw_agent.bridge import SWError


class TestConstraintTable(unittest.TestCase):
    def test_all_powers_of_two_and_distinct(self):
        values = list(refplane.CONSTRAINT.values())
        self.assertEqual(len(values), len(set(values)), "duplicate constraint values")
        for name, v in refplane.CONSTRAINT.items():
            self.assertTrue(v > 0 and v & (v - 1) == 0, f"{name}={v} is not a single bit")

    def test_documented_values(self):
        """Distance=8 (used since P13), Flip=256 (the value P105 should have used)."""
        self.assertEqual(refplane.CONSTRAINT["distance"], 8)
        self.assertEqual(refplane.CONSTRAINT["flip"], 256)

    def test_distance_plus_flip_is_264(self):
        # P105 passed 15 (Par|Perp|Coinc|Dist). P114 passed 16 to SelectByID2 (wrong API).
        mask = refplane.CONSTRAINT["distance"] | refplane.CONSTRAINT["flip"]
        self.assertEqual(mask, 264)
        self.assertNotEqual(mask, 15, "P105's mask was wrong")
        self.assertNotEqual(mask, 16, "P114's SelectOption was wrong")

    def test_constraint_mask_rejects_unknown(self):
        self.assertEqual(refplane.constraint_mask("distance"), 8)
        with self.assertRaises(SWError):
            refplane.constraint_mask("nope")


class TestWrongSide(unittest.TestCase):
    def test_correct_position(self):
        self.assertFalse(refplane.wrong_side(-0.05, -0.05, 2e-6))

    def test_opposite_sign(self):
        # The actual bug: -50 mm requested, plane built at +50 mm.
        self.assertTrue(refplane.wrong_side(0.05, -0.05, 5e-5))

    def test_wrong_magnitude(self):
        self.assertTrue(refplane.wrong_side(0.005, 0.05, 5e-5))

    def test_within_tolerance(self):
        self.assertFalse(refplane.wrong_side(0.0500004, 0.05, 5e-5))


class TestAxisMapping(unittest.TestCase):
    def test_y_up_convention(self):
        """SolidWorks is Y-up: Front normal=Z(2), Top normal=Y(1), Right normal=X(0)."""
        self.assertEqual(refplane.NORMAL_AXIS, {"front": 2, "top": 1, "right": 0})


if __name__ == "__main__":
    unittest.main()
