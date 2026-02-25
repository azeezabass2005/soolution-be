import { TRANSACTION_STATUS } from "../common/constant";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { TransactionStatus } from "../models/interface";

/**
 * Transaction State Machine Utility
 * 
 * Defines valid state transitions for transactions to prevent invalid status changes
 */
class TransactionStateMachine {
    /**
     * Valid state transitions map
     * Key: current status, Value: array of valid next statuses
     */
    private readonly validTransitions: Record<TransactionStatus, TransactionStatus[]> = {
        [TRANSACTION_STATUS.PENDING]: [
            TRANSACTION_STATUS.PROCESSING,
            TRANSACTION_STATUS.FAILED,
            TRANSACTION_STATUS.CANCELLED
        ],
        [TRANSACTION_STATUS.PENDING_INPUT]: [
            TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION,
            TRANSACTION_STATUS.AWAITING_CONFIRMATION,
            TRANSACTION_STATUS.FAILED,
            TRANSACTION_STATUS.CANCELLED
        ],
        [TRANSACTION_STATUS.AWAITING_KYC_VERIFICATION]: [
            TRANSACTION_STATUS.AWAITING_CONFIRMATION,
            TRANSACTION_STATUS.FAILED,
            TRANSACTION_STATUS.CANCELLED
        ],
        [TRANSACTION_STATUS.AWAITING_CONFIRMATION]: [
            TRANSACTION_STATUS.COMPLETED,
            TRANSACTION_STATUS.PROCESSING,
            TRANSACTION_STATUS.FAILED,
            TRANSACTION_STATUS.CANCELLED
        ],
        [TRANSACTION_STATUS.PROCESSING]: [
            TRANSACTION_STATUS.COMPLETED,
            TRANSACTION_STATUS.FAILED
        ],
        [TRANSACTION_STATUS.COMPLETED]: [], // Terminal state - no transitions allowed
        [TRANSACTION_STATUS.SUCCESSFUL]: [], // Terminal state - no transitions allowed
        [TRANSACTION_STATUS.FAILED]: [], // Terminal state - no transitions allowed
        [TRANSACTION_STATUS.CANCELLED]: [], // Terminal state - no transitions allowed
    };

    /**
     * Checks if a status transition is valid
     * @param currentStatus Current transaction status
     * @param newStatus Desired new status
     * @returns true if transition is valid, false otherwise
     */
    public canTransition(currentStatus: TransactionStatus, newStatus: TransactionStatus): boolean {
        const allowedTransitions = this.validTransitions[currentStatus];
        
        if (!allowedTransitions) {
            return false;
        }

        return allowedTransitions.includes(newStatus);
    }

    /**
     * Validates a status transition and throws error if invalid
     * @param currentStatus Current transaction status
     * @param newStatus Desired new status
     * @throws Error if transition is invalid
     */
    public validateTransition(currentStatus: TransactionStatus, newStatus: TransactionStatus): void {
        if (!this.canTransition(currentStatus, newStatus)) {
            throw errorResponseMessage.createError(
                400,
                `Invalid status transition from ${currentStatus} to ${newStatus}`,
                ErrorSeverity.HIGH
            );
        }
    }

    /**
     * Checks if a transaction can be updated (not in terminal state)
     * @param status Current transaction status
     * @returns true if transaction can be updated, false otherwise
     */
    public canBeUpdated(status: TransactionStatus): boolean {
        const terminalStates: TransactionStatus[] = [
            TRANSACTION_STATUS.COMPLETED,
            TRANSACTION_STATUS.SUCCESSFUL,
            TRANSACTION_STATUS.FAILED,
            TRANSACTION_STATUS.CANCELLED
        ];

        return !terminalStates.includes(status);
    }

    /**
     * Gets all valid next statuses for a given current status
     * @param currentStatus Current transaction status
     * @returns Array of valid next statuses
     */
    public getValidNextStatuses(currentStatus: TransactionStatus): TransactionStatus[] {
        return this.validTransitions[currentStatus] || [];
    }

    /**
     * Checks if a status is terminal (no further transitions allowed)
     * @param status Transaction status to check
     * @returns true if status is terminal, false otherwise
     */
    public isTerminalStatus(status: TransactionStatus): boolean {
        return this.getValidNextStatuses(status).length === 0;
    }
}

export default new TransactionStateMachine();
