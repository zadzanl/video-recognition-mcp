# Aturan:
# 1. Kode program hanya boleh ditulis didalam fungsi `run`
# 2. Dilarang mengubah penamaan dan struktur pada kode diluar fungsi `run`
# 3. Segala macam bentuk import yang dibutuhkan sudah dihandle oleh sistem
# 4. Kerjakan soal didalam fungsi `run`
# 5. Dilarang menghapus, mengubah nama dan parameter kode fungsi `run`
# 6. Seluruh input akan secara otomatis masuk ke parameter fungsi `run`
# 7. Output merupakan return dari fungsi `run` 
# 8. Tidak diperbolehkan menambahkan `input` dan `output` selain dari parameter dan return pada fungsi `run`
# 9. Tidak menaati keseluruhan aturan dapat menyebabkan program gagal dijalankan

def run(x):
    # solusi == pembagi habis -> sisa == 0
    # x == input

    pembagi = []
    baris = 0
    kolom = 0

    for baris in range (1, x + 1):
        if x % baris == 0:
            pembagi.append(baris)
            #print(pembagi)

    jawaban = ", ".join(map(str, pembagi))

    return

test_x = [100, 4, 13, 75, 80]

for x in test_x:
    print(run(x))