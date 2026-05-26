// Eigen SimplicialLDLT (AMD ordering) — handle-based C ABI for WASM.
//
// Multiple solver instances share one WASM heap. Each handle owns its
// SparseMatrix, SimplicialLDLT factorization, solution vector, and the
// triplet→CSC scatter map that lets setValues() update values in O(nnz)
// without re-sorting. setPattern() is called once per sparsity pattern;
// setValues() is called once per Newton iteration in the same triplet order.
//
// Exported symbols (all EMSCRIPTEN_KEEPALIVE):
//   int  create()
//   void destroy(int h)
//   void setPattern(int h, int n, int nnz, const int* I, const int* J)
//   void setValues(int h, int nnz, const double* V)
//   int  analyze(int h)
//   int  factorize(int h)
//   void solve(int h, const double* b, double* x, int n)
//   int  factorNnz(int h)

#include <Eigen/Sparse>
#include <emscripten.h>
#include <memory>
#include <vector>

using namespace Eigen;
typedef SparseMatrix<double> SpMat;
typedef SimplicialLDLT<SpMat, Lower> Solver;

struct SolverSlot {
    SpMat          A;
    Solver         solver;
    VectorXd       xsol;
    std::vector<int> scatterMap; // scatterMap[k] = index in A.valuePtr() for triplet k
    int            n   = 0;
    int            nnz = 0;
};

static std::vector<std::unique_ptr<SolverSlot>> g_slots;

extern "C" {

EMSCRIPTEN_KEEPALIVE
int create() {
    g_slots.push_back(std::make_unique<SolverSlot>());
    return (int)(g_slots.size() - 1);
}

EMSCRIPTEN_KEEPALIVE
void destroy(int h) {
    if (h >= 0 && h < (int)g_slots.size()) {
        g_slots[h].reset();
    }
}

// Build the n×n CSC structure from full-symmetric triplet coordinates
// (values treated as 1.0 for structure; duplicates are summed by
// setFromTriplets). Then build scatterMap: for each input triplet k,
// locate its slot in the compressed value array. Zero the value array.
EMSCRIPTEN_KEEPALIVE
void setPattern(int h, int n, int nnz, const int* I, const int* J) {
    SolverSlot& s = *g_slots[h];
    s.n   = n;
    s.nnz = nnz;

    // Build CSC structure using unit values so duplicates are merged.
    std::vector<Triplet<double>> trips;
    trips.reserve(nnz);
    for (int k = 0; k < nnz; k++) {
        trips.emplace_back(I[k], J[k], 1.0);
    }
    s.A.resize(n, n);
    s.A.setFromTriplets(trips.begin(), trips.end());
    s.A.makeCompressed();

    // Build scatter map: for each triplet k find the index in the
    // compressed value array where (I[k], J[k]) lives.
    //
    // A.outerIndexPtr()[col] is the start of column col in the CSC arrays.
    // A.innerIndexPtr()[pos] is the row at position pos.
    // We binary-search each column's row indices to find the slot.
    const int*    outer = s.A.outerIndexPtr();
    const int*    inner = s.A.innerIndexPtr();
    s.scatterMap.resize(nnz);

    for (int k = 0; k < nnz; k++) {
        int row = I[k];
        int col = J[k];
        int lo  = outer[col];
        int hi  = outer[col + 1];
        // Binary search for row within this column's row-index slice.
        while (lo < hi) {
            int mid = (lo + hi) / 2;
            if (inner[mid] < row)      lo = mid + 1;
            else if (inner[mid] > row) hi = mid;
            else { lo = mid; break; }
        }
        s.scatterMap[k] = lo;
    }

    // Zero the value array so the first setValues() starts clean.
    double* vals = s.A.valuePtr();
    int     nv   = (int)s.A.nonZeros();
    for (int i = 0; i < nv; i++) vals[i] = 0.0;
}

// Zero the CSC value array, then scatter-add triplet values:
//   for k: values[scatterMap[k]] += V[k]
// Duplicate (i,j) triplets are summed into the same CSC slot.
EMSCRIPTEN_KEEPALIVE
void setValues(int h, int nnz, const double* V) {
    SolverSlot& s = *g_slots[h];
    double* vals = s.A.valuePtr();
    int     nv   = (int)s.A.nonZeros();
    for (int i = 0; i < nv; i++) vals[i] = 0.0;
    for (int k = 0; k < nnz; k++) {
        vals[s.scatterMap[k]] += V[k];
    }
}

EMSCRIPTEN_KEEPALIVE
int analyze(int h) {
    SolverSlot& s = *g_slots[h];
    s.solver.analyzePattern(s.A);
    return (int)s.solver.info();
}

EMSCRIPTEN_KEEPALIVE
int factorize(int h) {
    SolverSlot& s = *g_slots[h];
    s.solver.factorize(s.A);
    return (int)s.solver.info();
}

EMSCRIPTEN_KEEPALIVE
void solve(int h, const double* b, double* x, int n) {
    SolverSlot& s = *g_slots[h];
    Map<const VectorXd> bb(b, n);
    s.xsol = s.solver.solve(bb);
    Map<VectorXd>(x, n) = s.xsol;
}

EMSCRIPTEN_KEEPALIVE
int factorNnz(int h) {
    SolverSlot& s = *g_slots[h];
    return (int)s.solver.matrixL().nestedExpression().nonZeros();
}

} // extern "C"
