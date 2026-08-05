"""Pure-logic tests for sw_agent.refplane — no SolidWorks, no COM.

The two failed fixes (P105 constraint 15, P114 select option 16) were both wrong about a
number, and nothing in the test suite could have caught either one. These lock down what
CAN be checked without a machine: the constraint table is a real set of bit flags with the
documented values, and the "did the plane land where we asked" decision is sign-aware.
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
        self.assertEqual(refplane.CONSTRAINT["distance"], 8)
        self.assertEqual(refplane.CONSTRAINT["flip"], 256)

    def test_distance_plus_flip_is_264(self):
        # P105 passed 15, which is Parallel|Perpendicular|Coincident|Distance.
        mask = refplane.CONSTRAINT["distance"] | refplane.CONSTRAINT["flip"]
        self.assertEqual(mask, 264)
        self.assertNotEqual(mask, 15)

    def test_constraint_lookup_rejects_unknown(self):
        self.assertEqual(refplane.constraint("distance"), refplane.CONSTRAINT["distance"])
        with self.assertRaises(SWError):
            refplane.constraint("nope")


class TestWrongSide(unittest.TestCase):
    def test_right_place_passes(self):
        self.assertFalse(refplane.wrong_side(-0.05, -0.05, 2e-6))

    def test_wrong_sign_fails(self):
        # The actual bug: -50 mm requested, plane built at +50 mm.
        self.assertTrue(refplane.wrong_side(0.05, -0.05, 5e-5))

    def test_wrong_magnitude_fails(self):
        self.assertTrue(refplane.wrong_side(0.005, 0.05, 5e-5))

    def test_within_tolerance_passes(self):
        self.assertFalse(refplane.wrong_side(0.0500004, 0.05, 5e-5))


class TestAxisMap(unittest.TestCase):
    def test_y_up_convention(self):
        # SolidWorks world space is Y-up: Front is XY (normal Z), Top is XZ (normal Y),
        # Right is YZ (normal X). Same mapping bridge.select_face uses.
        self.assertEqual(refplane.NORMAL_AXIS, {"front": 2, "top": 1, "right": 0})


if __name__ == "__main__":
    unittest.main()
