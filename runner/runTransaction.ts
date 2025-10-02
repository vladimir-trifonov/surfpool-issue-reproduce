import path from 'path';

type TransactionResult = string;

async function runTransaction(): Promise<void> {
    const [, , filePath, timeoutMsStr, latestBlockhash] = process.argv;

    if (!filePath || !timeoutMsStr || !latestBlockhash) {
        console.error('Usage: bun runTransaction.ts <file> <timeoutMs> <latestBlockhash>');
        process.exit(1);
    }

    const timeoutMs = parseInt(timeoutMsStr, 10);
    const absolutePath = path.resolve(filePath);

    try {
        const txModule = await import(absolutePath);

        if (typeof txModule.executeSkill !== 'function') {
            throw new Error('executeSkill function not found in the provided module.');
        }

        const serialized_tx: TransactionResult = await Promise.race([
            txModule.executeSkill(latestBlockhash),
            new Promise<TransactionResult>((_, reject) =>
                setTimeout(() => reject(new Error('Transaction execution timed out.')), timeoutMs)
            ),
        ]);

        console.log(JSON.stringify({
            success: true,
            serialized_tx,
        }));
    } catch (error: any) {
        // Log error to stderr for visibility
        console.error(error);

        // Extract error details
        let errorMessage = 'An unknown error occurred.';
        let errorDetails: string[] = [];

        // Handle Bun's AggregateError (compilation errors)
        if (error?.name === 'AggregateError' && Array.isArray(error.errors)) {
            errorMessage = error.message || 'Multiple errors occurred';
            for (const err of error.errors) {
                if (err?.message) {
                    errorDetails.push(err.message);
                } else {
                    errorDetails.push(String(err));
                }
            }
        } else if (error instanceof Error) {
            errorMessage = error.message;
            if (error.stack) {
                errorDetails.push(error.stack);
            } else {
                errorDetails.push(error.toString());
            }
        } else if (typeof error === 'string') {
            errorMessage = error;
            errorDetails.push(error);
        } else {
            errorDetails.push(String(error));
        }

        // Return JSON error response
        console.log(JSON.stringify({
            success: false,
            error: errorMessage,
            details: errorDetails.join('\n'),
            type: error?.name || 'UnknownError',
            errors: error?.errors?.map((e: any) => ({
                message: e?.message || String(e),
                line: e?.line,
                column: e?.column,
                file: e?.file
            }))
        }));
        process.exit(1);
    }
}

runTransaction();
