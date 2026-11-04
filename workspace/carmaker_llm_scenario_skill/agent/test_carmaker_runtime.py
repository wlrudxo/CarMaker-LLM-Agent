import math
import unittest

from carmaker_runtime import evaluate_expression


class TriggerTelemetryTests(unittest.TestCase):
    def test_invalid_or_missing_values_fail_closed(self):
        cases = [
            ("Car.v == 0", {}),
            ("Car.v > 1 || Traffic.T00.LongVel < 5", {"Car.v": 10.0}),
            ("Car.v != 0", {"Car.v": math.nan}),
            ("Car.v > 1", {"Car.v": math.inf}),
        ]
        for expression, values in cases:
            with self.subTest(expression=expression, values=values):
                self.assertFalse(evaluate_expression(expression, values))

    def test_valid_zero_and_math_expressions(self):
        self.assertTrue(evaluate_expression("Car.v == 0", {"Car.v": 0.0}))
        self.assertTrue(evaluate_expression("abs(Car.v) > 1", {"Car.v": -2.0}))


if __name__ == "__main__":
    unittest.main()
