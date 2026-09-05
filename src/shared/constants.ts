import { AppColor, CategoryIcon, TransactionType } from './enums';
import { CreateCategoryDto } from '@modules/categories/dto/create-category.dto';

export const MAX_CONFIRMATION_CODE_ATTEMPTS = 5;

export const DEFAULT_CATEGORIES: CreateCategoryDto[] = [
  { name: 'Salary', transaction_type: TransactionType.INCOME, icon: CategoryIcon.SALARY, color: AppColor.EVERGREEN },
  { name: 'Gifts', transaction_type: TransactionType.INCOME, icon: CategoryIcon.GIFTS, color: AppColor.CLAY },
  { name: 'Housing', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.HOUSING, color: AppColor.SLATE },
  {
    name: 'Transport',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.TRANSPORT,
    color: AppColor.INDIGO,
  },
  { name: 'Grocery', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.GROCERY, color: AppColor.EVERGREEN },
  {
    name: 'Restaurant',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.RESTAURANT,
    color: AppColor.CLAY,
  },
  { name: 'Car', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.CAR, color: AppColor.INDIGO },
  { name: 'Clothes', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.CLOTHES, color: AppColor.PLUM },
  { name: 'Health', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.HEALTH, color: AppColor.CLAY },
  {
    name: 'Entertainment',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.ENTERTAINMENT,
    color: AppColor.AMBER,
  },
  { name: 'Education', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.EDUCATION, color: AppColor.SLATE },
  { name: 'Travel', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.TRAVEL, color: AppColor.INDIGO },
  { name: 'Pets', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.PETS, color: AppColor.CLAY },
  {
    name: 'Electronics',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.ELECTRONICS,
    color: AppColor.SLATE,
  },
  { name: 'Utilities', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.UTILITIES, color: AppColor.SLATE },
];
