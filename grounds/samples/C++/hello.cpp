#include <iostream>

double f(double x) { return x * x; }

int main() {
    // A left Riemann sum of x^2 on [0, 2]; the exact area is 8/3.
    const int n = 1000;
    double dx = 2.0 / n, sum = 0;
    for (int i = 0; i < n; ++i) sum += f(i * dx) * dx;
    std::cout << "area ~ " << sum << "\n";
}
